import { z } from "zod";

import { getServerEnv } from "@/lib/env";

// Layout embeddings for receipt template retrieval, per
// docs/superpowers/specs/2026-07-26-ocr-rag-extraction-design.md sections 2.2
// and 7. Two pure helpers plus one network client, in that order of
// importance: `normalizeLayoutText` decides what the vector means,
// `cosineSimilarity` decides how vectors are compared, and `embedText` is a
// thin, replaceable call to Hugging Face.
//
// ============================ FROZEN CONVENTION ============================
// A stored embedding is compared against embeddings produced months later, by
// a different deploy, on a different receipt. Everything below is therefore
// part of a permanence problem of exactly the same kind as ./phash.ts, and it
// is spelled out rather than left to be inferred.
//
//  1. Model: sentence-transformers/all-MiniLM-L6-v2, served by hf-inference,
//     output pooled to 384 floats. Overridable through HF_EMBED_MODEL, which
//     is an escape hatch, not a knob.
//  2. Dimension: EMBEDDING_DIMENSIONS = 384. This number is pinned in THREE
//     places that must agree: this constant, the model above, and the
//     `receipt_templates.embedding vector(384)` column from migration 0024.
//
//     CHANGING THE MODEL IS A DATA MIGRATION, NOT A CONSTANT EDIT. A new model
//     produces vectors in a different space even at the identical dimension,
//     so every stored template embedding must be recomputed and rewritten
//     before the new model serves a single query. A half-migrated table
//     retrieves noise, and it does so silently: cosine similarity over two
//     unrelated spaces still returns a number between -1 and 1, and no error
//     is raised anywhere.
//  3. Input: the output of `normalizeLayoutText` applied to the receipt text,
//     never the raw text. The master template's `layout_text` column stores
//     that normalized form so what was embedded is inspectable after the fact.
//  4. Similarity: plain cosine on the returned vectors, no re-normalization on
//     our side. The model already emits unit-ish vectors; dividing by the
//     norms again is harmless and makes the helper correct for any input.
// ==========================================================================
//
// FAIL-SOFT, without exception. `embedText` returns null on every failure and
// throws nothing: no token, wrong dimension, 401, 429, 500, timeout, garbage
// body. Retrieval by embedding is an IMPROVEMENT on doc 36 Stage 6's heuristic
// template selection, not a replacement for it, so when embeddings are
// unavailable the caller falls back to that heuristic and the scan completes.
// An embedding outage must never cost a consumer their receipt.
//
// This module is server-side in practice (it reads HF_TOKEN and calls out over
// the network) but it deliberately does NOT import "server-only": the two pure
// helpers are the majority of the file and are needed by the template UI and
// by any future evaluation harness. Nothing secret is inlined by importing it,
// because non-NEXT_PUBLIC env is read at runtime through getServerEnv().

/**
 * The width of every vector this module produces and every vector stored in
 * `receipt_templates.embedding`. Pinned to the model. See the frozen
 * convention above before touching it.
 */
export const EMBEDDING_DIMENSIONS = 384;

/**
 * The model the 384 above belongs to. Verified live 2026-07-26: it is the one
 * embedding model served on the free `hf-inference` provider.
 */
export const DEFAULT_HF_EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2";

/** The router prefix; the model id and the pipeline path complete the URL. */
export const HF_EMBED_BASE_URL = "https://router.huggingface.co/hf-inference/models";

/**
 * Measured round trip on this model is well under a second. 15s is a generous
 * ceiling on a cold provider, and it is short enough that a wedged embedding
 * call cannot dominate the receipt-processing budget: the fallback to
 * heuristic template selection costs nothing, so waiting longer buys nothing.
 */
export const EMBED_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// normalizeLayoutText
// ---------------------------------------------------------------------------
//
// THE MOST IMPORTANT FUNCTION IN THIS FILE, and the one the plan's "Embedding
// the wrong thing" risk is about.
//
// The vector must describe the SHAPE of a shop's receipt, not the contents of
// one transaction. Reason the alternative through, because it is the failure
// mode that has no error message:
//
//   Take two receipts from the same cafe, one totalling 150.00 and one
//   totalling 890.00, and one receipt from a different shop that also totals
//   155.00. Embed the raw text. The two same-shop receipts now differ in every
//   amount on the slip - line totals, VATable sales, VAT, cash tendered,
//   change - while the two different-shop receipts share a whole column of
//   numerically similar tokens. The cross-shop pair can end up closer than the
//   same-shop pair. Retrieval then hands the extractor the WRONG template's
//   parse_config, tier 1 parsing quietly under-performs, and the only visible
//   symptom is a slow drift of receipts into the review queue. Nothing throws,
//   no log line fires, and the cause is three layers away from the effect.
//
// So every transaction-specific value is replaced by a CONSTANT placeholder,
// and the placeholder is kept rather than deleted because the fact that a line
// carries an amount is itself layout ("TOTAL <AMT>" is a totals line whatever
// the total was). Placeholders are constant across all receipts, so they
// contribute identically to every vector and cancel out of the comparison.
//
// STRIPPED (replaced by a placeholder):
//   - money amounts        -> <AMT>   the transaction's values, the main risk
//   - dates                -> <DATE>  changes on every single receipt
//   - clock times          -> <TIME>  likewise
//   - receipt/reference/TIN/serial numbers -> <REF>  per-transaction counters,
//     and for TIN a digit run that carries no layout information at all; the
//     LABEL is kept, only the number goes
//   - leading quantity columns -> <QTY>  basket-specific
//   - any other bare digit run -> <NUM>  phone numbers, item codes, table
//     numbers: none of them describe the layout
//
// KEPT:
//   - merchant name lines and header text, which is what actually identifies
//     the shop
//   - keyword labels verbatim: TOTAL, SUBTOTAL, VATABLE SALES, VAT, VAT-EXEMPT,
//     CASH, CHANGE, AMOUNT DUE, and any other wording the shop prints. This is
//     the vocabulary that distinguishes a VAT-registered POS slip from a
//     handwritten pad
//   - percentages such as "12%", which are part of a label ("12% VAT") rather
//     than a transaction value
//   - separator lines, canonicalized to a single "---" token so a 32-dash rule
//     and a 40-equals rule read as the same structural device
//   - footer text ("THIS SERVES AS AN OFFICIAL RECEIPT", "SALAMAT PO")
//   - THE ORDER OF THE LINES. Output is newline-joined in input order, because
//     header-then-items-then-totals-then-footer is the layout.
//
// Also: uppercased, whitespace collapsed, blank lines dropped. The function is
// pure, total (it throws on nothing) and idempotent: no placeholder contains a
// digit, so a second pass finds nothing left to replace.

/** Bounds on untrusted OCR text, mirroring ./parse.ts. A regex sweep over a
 * 300KB smear is a hung worker; over 20KB it is microseconds. */
const MAX_INPUT_LENGTH = 20_000;
const MAX_LINES = 400;
const MAX_LINE_LENGTH = 300;

const AMOUNT_PLACEHOLDER = "<AMT>";
const DATE_PLACEHOLDER = "<DATE>";
const TIME_PLACEHOLDER = "<TIME>";
const REFERENCE_PLACEHOLDER = "<REF>";
const QUANTITY_PLACEHOLDER = "<QTY>";
const NUMBER_PLACEHOLDER = "<NUM>";
const SEPARATOR_PLACEHOLDER = "---";

/** HH:mm with optional seconds and meridiem. Uppercased input, so AM/PM only. */
const TIME_PATTERN = /\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s*[AP]M)?\b/g;

const MONTH_ALTERNATION = "JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC";

/** "JULY 24, 2026" and "24 JULY 2026", the two spelled forms PH slips print. */
const NAMED_DATE_PATTERN = new RegExp(
  `\\b(?:(?:${MONTH_ALTERNATION})[A-Z]*\\.?\\s+\\d{1,2}\\s*,?\\s*\\d{2,4}` +
    `|\\d{1,2}\\s+(?:${MONTH_ALTERNATION})[A-Z]*\\.?\\s*,?\\s*\\d{2,4})\\b`,
  "g",
);

/** Any slash/dash/dot numeric date. Bracketed so a serial run cannot match. */
const NUMERIC_DATE_PATTERN = /(?<![\d/.-])\d{1,4}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{2,4}(?![\d/.-])/g;

/**
 * A labelled reference number: the label is captured and kept, the number is
 * replaced. Only labels that introduce an identifier are listed; TOTAL and the
 * money vocabulary are deliberately absent, because those labels introduce
 * amounts and amounts are handled by the money sweep.
 */
const LABELLED_REFERENCE_PATTERN =
  /\b(OR|SI|INV|INVOICE|RECEIPT|TRANS|TXN|REF|TIN|MIN|SN|SERIAL|PERMIT|ACCR|POS|TERM|TABLE|CASHIER|CHECK|BILL|BATCH|SLIP)\b[#:.\s]*(?:NO|NR|NUM|NUMBER)?[#:.\s]*\d[\dA-Z\-/]*/g;

/**
 * Money: a peso marker, or thousands separators, or a decimal fraction. A bare
 * integer is NOT money here - it falls to the generic number sweep below,
 * which erases it just the same, so the distinction only exists to keep the
 * "this line has a money column" signal honest.
 *
 * The leading lookbehind refuses a letter, which is what stops the optional
 * "P" marker eating the P of "SOUP 50.00". The trailing lookahead refuses a
 * digit, a separator or a percent sign, so "12%" is left alone.
 */
const MONEY_PATTERN =
  /(?<![A-Z0-9.,-])(?:(?:₱|PHP|P)[ \t]{0,2}(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2})(?![\d.,%])/g;

/** A non-global copy of the money pattern, purely so `.test` cannot be
 * corrupted by a stale `lastIndex`. */
const MONEY_TEST_PATTERN = new RegExp(MONEY_PATTERN.source);

/**
 * A leading quantity column, with or without an x/@ multiplier mark. Only
 * applied to a line that also carries an amount, because a quantity column
 * belongs to a line item and a line item has a money column. Without that
 * guard the street number in "123 Mabini St" reads as a quantity, which is
 * both wrong and a small loss: a street number is part of the header text that
 * identifies the shop.
 */
const LEADING_QUANTITY_PATTERN = /^\s*\d{1,3}\s*[X@]?\s*(?=[A-Z])/;

/** Whatever digits survived. The percent lookahead protects "12% VAT". */
const RESIDUAL_NUMBER_PATTERN = /(?<![A-Z0-9.,-])\d+(?![\d%])/g;

/** Three or more of the same rule character. Collapsed to one canonical token
 * so dashes, equals and asterisks of any length read as the same device. */
const SEPARATOR_RUN_PATTERN = /([=\-*_~.#])\1{2,}/g;

/**
 * The text that gets embedded: a receipt's layout with one transaction's
 * values removed. Pure, total and idempotent. See the long note above for
 * exactly what is stripped, what is kept, and why the distinction is the whole
 * point of this module.
 */
export function normalizeLayoutText(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return "";

  return raw
    .slice(0, MAX_INPUT_LENGTH)
    .split(/\r?\n/)
    .slice(0, MAX_LINES)
    .map((line) => normalizeLayoutLine(line.slice(0, MAX_LINE_LENGTH)))
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Order is load-bearing and not arbitrary. Times go first so a clock is never
 * read as a fraction; dates next so "07/24/2026" is never read as three
 * numbers; labelled references before the money sweep so "OR# 004512" keeps
 * its label; quantities before the residual sweep so a leading count is
 * recognisable as a count; money before the residual sweep so a decimal amount
 * is not shredded into two integers.
 */
function normalizeLayoutLine(line: string): string {
  const identified = line
    .toUpperCase()
    .replace(TIME_PATTERN, TIME_PLACEHOLDER)
    .replace(NAMED_DATE_PATTERN, DATE_PLACEHOLDER)
    .replace(NUMERIC_DATE_PATTERN, DATE_PLACEHOLDER)
    .replace(
      LABELLED_REFERENCE_PATTERN,
      (_match, label: string) => `${label} ${REFERENCE_PLACEHOLDER}`,
    );

  const counted = MONEY_TEST_PATTERN.test(identified)
    ? identified.replace(LEADING_QUANTITY_PATTERN, `${QUANTITY_PLACEHOLDER} `)
    : identified;

  return counted
    .replace(MONEY_PATTERN, AMOUNT_PLACEHOLDER)
    .replace(RESIDUAL_NUMBER_PATTERN, NUMBER_PLACEHOLDER)
    .replace(SEPARATOR_RUN_PATTERN, SEPARATOR_PLACEHOLDER)
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

/**
 * Cosine similarity in [-1, 1]. Pure.
 *
 * Two explicit decisions:
 *   - Mismatched lengths THROW. Comparing a 384-vector against a 512-vector is
 *     never a data condition, it is a model or migration mistake, and the only
 *     honest answer is to stop rather than to return a number computed over a
 *     prefix.
 *   - A zero vector returns 0, not NaN. The angle is genuinely undefined, but
 *     a NaN propagates into a sort comparator and silently scrambles the
 *     ranking of every OTHER candidate, which is far worse than "no evidence
 *     of similarity". 0 says exactly that.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity needs vectors of equal length, received ${a.length} and ${b.length}`,
    );
  }
  if (a.length === 0) {
    throw new Error("cosineSimilarity needs non-empty vectors");
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) return 0;

  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  if (!Number.isFinite(similarity)) return 0;
  // Floating point can carry an identical pair a hair past 1.
  return Math.min(1, Math.max(-1, similarity));
}

// ---------------------------------------------------------------------------
// embedText
// ---------------------------------------------------------------------------

/**
 * Both response shapes the endpoint produces, measured 2026-07-26. A single
 * string input can come back as a flat array of 384 floats, or wrapped as
 * `[[...384]]` - the wrapping depends on how the request body is shaped and it
 * is not worth depending on. Validated rather than trusted: this is somebody
 * else's service and a routing change that returns an HTML error page with a
 * 200 must produce a null, not `undefined.length` inside a pgvector literal.
 */
const flatVectorSchema = z.array(z.number());
const nestedVectorSchema = z.array(flatVectorSchema);

export interface EmbedOptions {
  /** Defaults to HF_TOKEN. */
  token?: string;
  /** Defaults to HF_EMBED_MODEL, then to DEFAULT_HF_EMBED_MODEL. */
  model?: string;
  /** Defaults to EMBED_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to HF_EMBED_BASE_URL. */
  baseUrl?: string;
}

/** Read the two optional keys without letting an unrelated server-env problem
 * (a missing Redis URL, say) turn into a thrown embedding call. */
function envDefaults(): { token: string | undefined; model: string | undefined } {
  try {
    const serverEnv = getServerEnv();
    return { token: serverEnv.HF_TOKEN, model: serverEnv.HF_EMBED_MODEL };
  } catch {
    return { token: undefined, model: undefined };
  }
}

/**
 * Pull the 384-float vector out of a parsed body, or null.
 *
 * A nested response must carry EXACTLY one row. We send exactly one input, so
 * one row is the contract; several rows means either a batched response we did
 * not ask for or per-token embeddings that were never pooled, and neither is a
 * thing to store in a column whose meaning is "one vector per template".
 */
function readVector(body: unknown): number[] | null {
  const nested = nestedVectorSchema.safeParse(body);
  if (nested.success) {
    if (nested.data.length !== 1) return null;
    return nested.data[0] ?? null;
  }
  const flat = flatVectorSchema.safeParse(body);
  return flat.success ? flat.data : null;
}

/**
 * The layout vector for a piece of text, or null.
 *
 * Callers pass `normalizeLayoutText(...)` output, not raw OCR text; this
 * function does not normalize on the caller's behalf, because whether a given
 * string has already been normalized is the caller's knowledge, and
 * normalizing twice would hide a caller that forgot to store `layout_text`.
 *
 * Returns null and never throws. Every branch below is a null: no token, empty
 * text, a non-2xx status, a non-JSON body, an unexpected shape, a wrong
 * dimension, a non-finite float, a timeout, an unreachable host.
 */
export async function embedText(
  text: string,
  options: EmbedOptions = {},
): Promise<number[] | null> {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length === 0) return null;

  const defaults = envDefaults();
  const token = options.token ?? defaults.token;
  if (token === undefined || token.length === 0) {
    // Not an error and not worth a log line on every scan: an unset HF_TOKEN
    // is the documented state of a dev environment, and the caller's fallback
    // to heuristic template selection is the designed behaviour.
    return null;
  }

  const model = options.model ?? defaults.model ?? DEFAULT_HF_EMBED_MODEL;
  const baseUrl = options.baseUrl ?? HF_EMBED_BASE_URL;
  const timeoutMs = options.timeoutMs ?? EMBED_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, "")}/${model}/pipeline/feature-extraction`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: trimmed }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // 401 is a bad token, 429 is the free tier throttling, 5xx is the
      // provider. They differ in what an operator should do about them and not
      // at all in what this function returns, so the status travels in the log
      // and the caller gets one null.
      console.warn(
        `[receipts/embed] embedding request failed with status ${response.status}, falling back to heuristic template selection`,
      );
      return null;
    }

    const vector = readVector(await response.json());
    if (vector === null) {
      console.warn("[receipts/embed] embedding response had an unexpected shape");
      return null;
    }

    if (vector.length !== EMBEDDING_DIMENSIONS) {
      // The load-bearing check. A 512-float answer means HF_EMBED_MODEL points
      // at a different model than the one the vector(384) column was built
      // for. Storing it is not possible and pretending otherwise turns a
      // configuration mistake into a database error at write time, three
      // stages later, on the money path.
      console.error(
        `[receipts/embed] model ${model} returned ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}. HF_EMBED_MODEL does not match the vector(${EMBEDDING_DIMENSIONS}) column.`,
      );
      return null;
    }

    if (!vector.every((value) => Number.isFinite(value))) {
      console.warn("[receipts/embed] embedding contained a non-finite value");
      return null;
    }

    return vector;
  } catch (error) {
    // Timeout, abort, DNS, TLS, connection reset, or a non-JSON body. All of
    // them are "no embedding this time".
    console.warn("[receipts/embed] embedding call failed", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
