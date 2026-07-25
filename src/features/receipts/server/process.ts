import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { expireNx, incr, redisKey } from "@/lib/redis";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/lib/supabase/types";

import {
  parseConfidence,
  routeReceipt,
  shouldEmitLowConfidenceSignal,
} from "../confidence";
import { buildSignal, fraudVerdict } from "../fraud";
import type { FraudSignal } from "../fraud";
import { matchBusiness, trigramSimilarity } from "../matching";
import type { MatchCandidate } from "../matching";
import { parseReceipt } from "../parse";
import type { ParseConfig, ParsedReceipt } from "../parse";
import { hammingDistance, phashBand } from "../phash";
import type { FieldSource, ReceiptRejectReason, RouteOutcome } from "../types";
import { evaluateVelocity } from "../velocity";
import type { VelocityCounts, VelocityWindow } from "../velocity";
import { awardPoints, priceReceipt } from "./award";
import type { AwardPlan } from "./award";
import { applyCooldownIfEarned, isFraudFamilyRejectReason } from "./cooldown";
import { getOcrProvider, OcrError } from "./ocr/provider";
import type { OcrBlock, OcrProvider, OcrResponse } from "./ocr/provider";
import { getReceiptSettings } from "./settings";
import type { ReceiptSettings } from "./settings";

// ===========================================================================
// The receipt processing orchestration: doc 36's Stages 2 through 10 in one
// place, ending in the award RPC (supabase/migrations/0018_award_receipt_points
// .sql), which is the second and last place in the system that writes the
// points ledger.
//
// QUEUE-SHAPED ON PURPOSE. `processReceipt` takes ONE receipt id and nothing
// else: no request context, no session, no supplied payload. Doc 36 Stage 2
// puts this behind the `ocr.process` QStash queue, and the jobs slice will
// swap today's synchronous call (from the submit endpoint) for an enqueue plus
// a Route Handler that unwraps `{receipt_id}` and calls exactly this function.
// That swap has to be mechanical, which is why every fact this function needs
// is re-read from the database under the service role rather than passed in.
//
// IT NEVER THROWS. Every failure is either a terminal receipt status or a
// retryable state the next attempt picks up (see "Failure handling" below).
// A pipeline that throws would either take down a caller that must still
// answer 202, or - once queued - retry forever on a permanent failure.
//
// ORDER OF WRITES is load-bearing and not obvious, so it is stated once here:
//
//   1. status='processing'         claim the receipt (doc 36 Stage 2)
//   2. ocr_results + ai_usage_events   evidence and metering, one row per
//                                      attempt (UNIQUE (receipt_id, attempt))
//   3. ONE update to receipts      business_id + every parsed field + both
//                                  confidences + parse_meta + the terminal
//                                  status, together
//   4. fraud_signals, receipt_line_items
//   5. award_receipt_points        approved path only, points > 0 only
//
// Step 5 does NOT live here. Pricing and the award RPC are `./award.ts`, the
// one path this pipeline and the human review service share (doc 36 Stage 9:
// "no separate code path, so ledger invariants hold"). What stays here is the
// pipeline's own business: when to price, and that the terminal 'approved'
// write lands before the RPC, which 0018 guards on.
//
// Step 3 is a single statement rather than "persist parse, then set status"
// for two reasons that both bite:
//   * `receipts_number_unique` (0017) is a partial unique index over status in
//     ('approved','review','processing'). Writing `receipt_number` while the
//     row is still 'processing' would raise 23505 for a receipt we are about
//     to reject as a duplicate anyway - the rejection has to land in the same
//     statement that writes the number, because rejected rows are outside the
//     index.
//   * `fraud_signals` and `receipt_line_items` both carry a composite FK
//     (receipt_id, business_id) -> receipts (id, business_id) (0017). Their
//     denormalized business_id is only insertable once the parent receipt
//     already names that tenant, so step 3 must precede step 4.
//
// Docs: docs/30-modules/36-receipt-ocr-pipeline.md (Stages 2-10, retry/DLQ),
// docs/30-modules/37-fraud-detection.md (signals S1-S9, scoring, ladder step
// 2), docs/30-modules/35-points-engine.md (award, rule_snapshot),
// docs/20-data/24-schema-receipts-ai.md (storage contract).
// ===========================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Private bucket created by 0019_receipts_storage.sql. */
const RECEIPTS_BUCKET = "receipts";
/** Doc 36 Stage 4 / doc 15: 5-minute signed URL to the receipts object. */
const SIGNED_URL_TTL_SECONDS = 300;
/** Every PH paper receipt's wall clock, and the zone doc 40 defines days in. */
const RECEIPT_TIMEZONE = "Asia/Manila";
/** Doc 36 Stage 8 "Not future": `receipt_date <= now() + 24h` (TZ grace). */
const FUTURE_GRACE_MS = 24 * 60 * 60 * 1000;
/** Doc 37 S1 MVP candidate set: same business, last 90 days. */
const PHASH_LOOKBACK_DAYS = 90;
/**
 * Cap on either half of the pHash candidate set. Doc 37 says candidate sets
 * are "small enough that no BK-tree is needed until [SCALE]"; this is what
 * keeps that true for a consumer with years of history, and it takes the most
 * recent rows because a replay attack reuses a recent image.
 */
const PHASH_CANDIDATE_LIMIT = 500;
/** Doc 37 S7 round-number abuse: "last >= 5 approved receipts". */
const ROUND_NUMBER_STREAK = 5;
/** PHP 100.00. Doc 37 S7's `total_centavos % 10000 = 0`. */
const ROUND_NUMBER_MODULUS = 10_000;

/**
 * The statuses `receipts_number_unique` covers (0017). A number held by one of
 * these rows is a LIVE claim; a rejected row's number is free to reuse, which
 * is what makes honest resubmission after a rejection work.
 */
const LIVE_STATUSES = ["approved", "review", "processing"] as const;

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** The two Redis commands the velocity windows need (doc 37 S4). */
export interface VelocityRedis {
  incr(key: string): Promise<number>;
  expireNx(key: string, seconds: number): Promise<boolean>;
}

/**
 * Everything this module talks to that is not pure. Injected rather than
 * imported at the call sites so the whole stage chain is exercisable without a
 * database, a storage bucket, an OCR container or a Redis instance - which is
 * the only way a money path this long gets honestly tested.
 */
export interface ProcessReceiptDeps {
  /** SERVICE ROLE. Every receipt write is service-role by RLS design (0017). */
  supabase: SupabaseClient<Database>;
  ocr: OcrProvider;
  /** Business scope overrides platform scope; never throws (see settings.ts). */
  loadSettings: (businessId?: string) => Promise<ReceiptSettings>;
  redis: VelocityRedis;
  now: () => Date;
}

/**
 * The production wiring. Returns null when the service-role key is absent
 * (createServiceRoleClient's documented degraded path) or when the OCR
 * provider is half-configured, because both of those are deployment mistakes
 * that must fail loudly in the log rather than silently mis-process a receipt.
 */
export function defaultProcessReceiptDeps(): ProcessReceiptDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error(
      "[receipts/process] SUPABASE_SERVICE_ROLE_KEY is not configured; cannot process receipts",
    );
    return null;
  }
  try {
    return {
      supabase,
      ocr: getOcrProvider(),
      loadSettings: getReceiptSettings,
      redis: { incr, expireNx },
      now: () => new Date(),
    };
  } catch (error) {
    console.error("[receipts/process] OCR provider is misconfigured", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface ReceiptRow {
  id: string;
  business_id: string | null;
  user_id: string;
  status: string;
  image_path: string;
  image_hash: string;
  device_id: string | null;
  created_at: string;
}

export interface TemplateRow {
  id: string;
  source_kind: string;
  parse_config: Json;
}

export interface SelectedTemplate {
  id: string;
  sourceKind: string;
  config: ParseConfig;
}

interface PostgrestFailure {
  message: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Round-trip through JSON exactly as the wire would. Used for every jsonb
 * column this module writes (`evidence`, `parse_meta`, `rule_snapshot`): it
 * drops `undefined` keys, proves the value is serializable before it reaches
 * the driver, and keeps the stored document identical to the one reasoned
 * about here.
 */
function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

/** numeric(4,3) is the domain of both confidence columns (0017). Rounding here
 * means the value routed on and the value a reviewer reads back are the same
 * number; `routeReceipt` quantizes to the same precision internally. */
function toStoredConfidence(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isUniqueViolation(error: PostgrestFailure | null): boolean {
  return error?.code === UNIQUE_VIOLATION;
}

/** The Asia/Manila calendar day of an instant, as `YYYY-MM-DD`. Doc 40's
 * timezone canon, and the bucket every daily velocity window is keyed by. */
function manilaDay(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: RECEIPT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * `image_path` is bucket-relative (`{user_id}/{uuid}.jpg`, doc 15 / spec 3.3),
 * but doc 36 Stage 1 writes the same path once as `receipts/{user_id}/...`.
 * Accept both. A user id is a uuid and can never be the literal "receipts", so
 * stripping the prefix cannot corrupt a legitimate path.
 */
function toObjectPath(imagePath: string): string {
  const prefix = `${RECEIPTS_BUCKET}/`;
  return imagePath.startsWith(prefix) ? imagePath.slice(prefix.length) : imagePath;
}

// ---------------------------------------------------------------------------
// parse_config sanitization
// ---------------------------------------------------------------------------
//
// `receipt_templates.parse_config` is jsonb authored by business staff in the
// portal, so nothing about its shape is guaranteed. parse.ts is already
// defensive about the two untrusted REGEX fields (length caps, a nested
// quantifier check, bounded input), but it reasonably assumes that a keyword
// list contains strings: a number in `total_keywords` would reach
// `String.prototype.trim` and throw, taking down the receipt.
//
// Sanitizing here rather than trusting the column keeps that failure mode out
// of the pipeline entirely, and it degrades per FIELD: one malformed key drops
// only itself, never the whole template.
//
// One distinction is preserved deliberately: an EMPTY `tax_keywords` array is
// meaningful (parse.ts reads it as "non-VAT business, skip the 12% check"), so
// empty arrays survive while non-arrays become absent.

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function verticalBand(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const top = optionalNumber(value[0]);
  const bottom = optionalNumber(value[1]);
  if (top === undefined || bottom === undefined) return undefined;
  return [top, bottom];
}

function layoutRegion(value: unknown): { y?: [number, number]; align?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const region: { y?: [number, number]; align?: string } = {};
  const band = verticalBand(value.y);
  if (band !== undefined) region.y = band;
  const align = optionalString(value.align);
  if (align !== undefined) region.align = align;
  return region;
}

export function sanitizeParseConfig(raw: unknown): ParseConfig {
  const source = isRecord(raw) ? raw : {};
  const config: ParseConfig = {};

  const aliases = stringArray(source.merchant_aliases);
  if (aliases !== undefined) config.merchant_aliases = aliases;
  const tin = optionalString(source.tin);
  if (tin !== undefined) config.tin = tin;
  const receiptNoRegex = optionalString(source.receipt_no_regex);
  if (receiptNoRegex !== undefined) config.receipt_no_regex = receiptNoRegex;
  const dateFormats = stringArray(source.date_formats);
  if (dateFormats !== undefined) config.date_formats = dateFormats;
  const totalKeywords = stringArray(source.total_keywords);
  if (totalKeywords !== undefined) config.total_keywords = totalKeywords;
  const subtotalKeywords = stringArray(source.subtotal_keywords);
  if (subtotalKeywords !== undefined) config.subtotal_keywords = subtotalKeywords;
  const taxKeywords = stringArray(source.tax_keywords);
  if (taxKeywords !== undefined) config.tax_keywords = taxKeywords;
  const lineItemPattern = optionalString(source.line_item_pattern);
  if (lineItemPattern !== undefined) config.line_item_pattern = lineItemPattern;

  if (isRecord(source.layout_anchors)) {
    const anchors: NonNullable<ParseConfig["layout_anchors"]> = {};
    const header = layoutRegion(source.layout_anchors.header);
    if (header !== undefined) anchors.header = header;
    const lineItems = layoutRegion(source.layout_anchors.line_items);
    if (lineItems !== undefined) anchors.line_items = lineItems;
    const totals = layoutRegion(source.layout_anchors.totals);
    if (totals !== undefined) anchors.totals = totals;
    const footerKeywords = stringArray(source.layout_anchors.footer_keywords);
    if (footerKeywords !== undefined) anchors.footer_keywords = footerKeywords;
    config.layout_anchors = anchors;
  }

  if (isRecord(source.amount_sanity)) {
    const bounds: NonNullable<ParseConfig["amount_sanity"]> = {};
    const min = optionalNumber(source.amount_sanity.min_total_centavos);
    if (min !== undefined) bounds.min_total_centavos = min;
    const max = optionalNumber(source.amount_sanity.max_total_centavos);
    if (max !== undefined) bounds.max_total_centavos = max;
    config.amount_sanity = bounds;
  }

  if (isRecord(source.handwriting)) {
    const handwriting: NonNullable<ParseConfig["handwriting"]> = {};
    const minBlockConf = optionalNumber(source.handwriting.min_block_conf);
    if (minBlockConf !== undefined) handwriting.min_block_conf = minBlockConf;
    if (typeof source.handwriting.digits_only_amounts === "boolean") {
      handwriting.digits_only_amounts = source.handwriting.digits_only_amounts;
    }
    config.handwriting = handwriting;
  }

  return config;
}

// ---------------------------------------------------------------------------
// Stage 6 - template selection
// ---------------------------------------------------------------------------

/**
 * Doc 36 Stage 6's layout heuristics, applied to what the OCR service actually
 * returned: dense monospaced lines plus a VAT block means `pos`; a letterhead
 * with "INVOICE"/"SI No." means `invoice`; low block alignment plus low OCR
 * confidence means `handwritten`.
 */
export function detectSourceKind(response: {
  rawText: string;
  blocks: OcrBlock[];
  meanConfidence: number;
}): "pos" | "invoice" | "handwritten" {
  const text = response.rawText.toUpperCase();
  const leftEdges = response.blocks.map((block) => block.bbox[0]);
  const distinctLeftEdges = new Set(leftEdges).size;
  // A POS or an invoice prints from a fixed left margin, so nearly every block
  // shares a handful of x origins. A pad written by hand does not.
  const alignmentRatio =
    leftEdges.length === 0 ? 0 : 1 - (distinctLeftEdges - 1) / leftEdges.length;

  if (response.meanConfidence < 0.6 && alignmentRatio < 0.6) return "handwritten";
  if (/\bINVOICE\b/.test(text) || /\bSI\s*NO\b/.test(text)) return "invoice";
  return "pos";
}

/**
 * Doc 36 Stage 6 selection: score each active validated template of the
 * matched business by its `source_kind` layout heuristic and by the fraction
 * of its `layout_anchors` that are actually present, highest scorer wins.
 *
 * Two readings the doc leaves open, decided here:
 *
 *   * A business with exactly ONE active validated template always wins with
 *     it, score irrelevant. There is nothing to disambiguate, and refusing to
 *     use it would throw away the receipt_no_regex and date_formats the owner
 *     configured precisely so their receipts parse.
 *   * With SEVERAL templates and no distinguishing evidence at all (every
 *     score 0), no winner is declared and the generic tier runs. Picking one
 *     arbitrarily would apply another layout's regexes to this receipt, which
 *     silently mis-parses rather than under-parses.
 */
export function selectTemplate(
  templates: readonly TemplateRow[],
  response: { rawText: string; blocks: OcrBlock[]; meanConfidence: number },
): SelectedTemplate | null {
  if (templates.length === 0) return null;

  const only = templates[0];
  if (templates.length === 1 && only !== undefined) {
    return {
      id: only.id,
      sourceKind: only.source_kind,
      config: sanitizeParseConfig(only.parse_config),
    };
  }

  const detectedKind = detectSourceKind(response);
  const haystack = response.rawText.toUpperCase();

  let best: { template: SelectedTemplate; score: number } | null = null;
  for (const row of templates) {
    const config = sanitizeParseConfig(row.parse_config);
    const anchors = config.layout_anchors?.footer_keywords ?? [];
    const anchorHits = anchors.filter((keyword) =>
      haystack.includes(keyword.toUpperCase()),
    ).length;
    const anchorScore = anchors.length === 0 ? 0 : anchorHits / anchors.length;
    const kindScore = row.source_kind === detectedKind ? 1 : 0;
    const score = 0.5 * anchorScore + 0.5 * kindScore;

    if (best === null || score > best.score) {
      best = {
        template: { id: row.id, sourceKind: row.source_kind, config },
        score,
      };
    }
  }

  if (best === null || best.score <= 0) return null;
  return best.template;
}

// ---------------------------------------------------------------------------
// Stage 8 - validation
// ---------------------------------------------------------------------------

interface ValidationResult {
  /** Set when doc 36 Stage 8 rejects outright. */
  rejection: ReceiptRejectReason | null;
  /** Amount sanity: doc 36 Stage 8 routes these to a human, never rejects. */
  forceReview: boolean;
  /** History and context rows, folded into the fraud pass. */
  signals: FraudSignal[];
}

export function validateParsedReceipt(input: {
  parsed: ParsedReceipt;
  now: Date;
  maxAgeDays: number;
  businessVerifiedAt: Date | null;
}): ValidationResult {
  const { parsed, now, maxAgeDays, businessVerifiedAt } = input;
  const signals: FraudSignal[] = [];

  // Readability (doc 36 Stage 8 row 1). A receipt with no total cannot be
  // priced, and one with neither a date nor a number cannot be told apart from
  // any other receipt at that store.
  const readable =
    parsed.totalCentavos !== null &&
    (parsed.receiptDate !== null || parsed.receiptNumber !== null);
  if (!readable) {
    return { rejection: "unreadable", forceReview: false, signals };
  }

  const receiptDate = parsed.receiptDate;
  if (receiptDate !== null) {
    // Not future (doc 36 Stage 8 row 3): a signal, explicitly NOT a rejection.
    if (receiptDate.getTime() > now.getTime() + FUTURE_GRACE_MS) {
      signals.push(
        buildSignal("timestamp_future_dated", {
          kind: "future_dated",
          receipt_date: receiptDate.toISOString(),
          grace_hours: 24,
        }),
      );
    }

    // Freshness (row 2) and postdates-activation (row 4) both reject as
    // too_old, and doc 37 S5 wants a history row when they do.
    const freshnessFloor = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
    if (receiptDate.getTime() < freshnessFloor) {
      signals.push(
        buildSignal("timestamp_too_old", {
          kind: "stale",
          receipt_date: receiptDate.toISOString(),
          max_age_days: maxAgeDays,
        }),
      );
      return { rejection: "too_old", forceReview: false, signals };
    }

    if (
      businessVerifiedAt !== null &&
      receiptDate.getTime() < businessVerifiedAt.getTime()
    ) {
      signals.push(
        buildSignal("timestamp_too_old", {
          kind: "predates_activation",
          receipt_date: receiptDate.toISOString(),
          business_verified_at: businessVerifiedAt.toISOString(),
        }),
      );
      return { rejection: "too_old", forceReview: false, signals };
    }
  }
  // A dateless receipt that passed readability on its number alone cannot be
  // tested for freshness at all. Doc 36 Stage 8 states both date rules in
  // terms of `receipt_date`, so an absent date skips them rather than failing
  // them; the missing date has already cost 0.20 of parse_confidence, which is
  // where that uncertainty is meant to be priced.

  // Amount sanity (row 6): route to review, never reject. `withinAmountSanity`
  // is null when the template declared no bounds.
  const forceReview = parsed.withinAmountSanity === false;

  return { rejection: null, forceReview, signals };
}

// ---------------------------------------------------------------------------
// Stage 7 fraud - velocity windows
// ---------------------------------------------------------------------------

interface VelocityWindowSpec {
  window: VelocityWindow;
  key: string;
  ttlSeconds: number;
}

function velocityWindowSpecs(input: {
  now: Date;
  userId: string;
  businessId: string | null;
  deviceId: string | null;
}): VelocityWindowSpec[] {
  const { now, userId, businessId, deviceId } = input;
  const day = manilaDay(now);
  const hourBucket = String(Math.floor(now.getTime() / 3_600_000));
  const tenMinuteBucket = String(Math.floor(now.getTime() / 600_000));

  const specs: VelocityWindowSpec[] = [
    {
      window: "consumer_hour",
      key: redisKey("receipts", "velocity", "consumer_hour", userId, hourBucket),
      ttlSeconds: 3_600,
    },
    {
      window: "consumer_day",
      key: redisKey("receipts", "velocity", "consumer_day", userId, day),
      ttlSeconds: 86_400,
    },
  ];

  if (businessId !== null) {
    specs.push(
      {
        window: "pair_day",
        key: redisKey("receipts", "velocity", "pair_day", userId, businessId, day),
        ttlSeconds: 86_400,
      },
      {
        window: "pair_10min",
        key: redisKey(
          "receipts",
          "velocity",
          "pair_10min",
          userId,
          businessId,
          tenMinuteBucket,
        ),
        ttlSeconds: 600,
      },
    );
  }

  if (deviceId !== null) {
    specs.push({
      window: "device_day",
      key: redisKey("receipts", "velocity", "device_day", deviceId, day),
      ttlSeconds: 86_400,
    });
  }

  return specs;
}

/**
 * Doc 37 S4's five sliding windows. Counts include the receipt being
 * processed, which is what makes the doc's own evidence example
 * (`{"window":"pair_10min","count":3,"cap":2}`) read correctly.
 *
 * FAILS OPEN, per window. Doc 37 is explicit that these counters are a hot
 * path and "losing Redis loses speed, never truth" (D4). A window whose INCR
 * failed is left ABSENT rather than zero: `evaluateVelocity` skips absent
 * windows, so an outage can neither manufacture a fraud signal nor suppress
 * the other four. This is the one detector that fails open; every other one in
 * this file reads Postgres, where an error is a real error.
 */
async function collectVelocityCounts(
  redis: VelocityRedis,
  specs: readonly VelocityWindowSpec[],
): Promise<VelocityCounts> {
  const counts: Partial<Record<VelocityWindow, number>> = {};
  for (const spec of specs) {
    try {
      const count = await redis.incr(spec.key);
      // Self-healing TTL, same argument as src/lib/rate-limit.ts: EXPIRE NX is
      // idempotent, so a key that lost its TTL repairs itself on the next scan
      // instead of counting up forever.
      await redis.expireNx(spec.key, spec.ttlSeconds);
      counts[spec.window] = count;
    } catch (error) {
      console.warn(
        `[receipts/process] velocity window "${spec.window}" unavailable; skipping it`,
        error,
      );
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// The orchestration
// ---------------------------------------------------------------------------

/**
 * Turn one queued receipt into an outcome, and - when that outcome is
 * `approved` and the business's rules price it above zero - into points.
 *
 * Queue-shaped: the id is the entire input, so the jobs slice can call this
 * from a QStash Route Handler with no other change (doc 36 Stage 2).
 *
 * Idempotent by status: a receipt that is not `queued` or `processing` is
 * acked and ignored, exactly as doc 36 Stage 2 requires. Re-running an
 * approved receipt therefore awards nothing a second time, and the
 * `pt_receipt_earn_once` index in the database is the backstop under that.
 */
export async function processReceipt(
  receiptId: string,
  deps: ProcessReceiptDeps | null = defaultProcessReceiptDeps(),
): Promise<void> {
  if (deps === null) return;

  try {
    await runPipeline(receiptId, deps);
  } catch (error) {
    // Last-resort net. Anything reaching here is unexpected (a driver fault, a
    // programming error), and the receipt is left in whatever state the last
    // successful write put it in. If that state is 'processing' the next
    // attempt picks it straight back up, because 'processing' is explicitly
    // retry-eligible in doc 36 Stage 2.
    // TODO(queue): once the jobs slice owns retries, rethrow here so QStash
    // sees a non-2xx and applies its backoff instead of relying on a later
    // sweep to notice the row.
    console.error(`[receipts/process] unexpected failure on receipt ${receiptId}`, error);
  }
}

async function runPipeline(receiptId: string, deps: ProcessReceiptDeps): Promise<void> {
  const { supabase, now } = deps;

  // ---- Stage 2: load and claim -------------------------------------------
  const { data: receipt, error: loadError } = await supabase
    .from("receipts")
    .select(
      "id, business_id, user_id, status, image_path, image_hash, device_id, created_at",
    )
    .eq("id", receiptId)
    .maybeSingle<ReceiptRow>();

  if (loadError !== null) {
    console.error(`[receipts/process] could not load receipt ${receiptId}`, loadError);
    return;
  }
  if (receipt === null) {
    console.warn(`[receipts/process] receipt ${receiptId} does not exist; acking`);
    return;
  }

  // Doc 36 Stage 2, verbatim: "if receipts.status is not queued/processing,
  // ack and exit". This is the whole of the job-level idempotency guarantee -
  // a redelivered QStash message, a double-click on a retry button, or a
  // second worker all land here and stop, so an already-approved receipt can
  // never be re-parsed, re-scored, or re-awarded.
  if (receipt.status !== "queued" && receipt.status !== "processing") {
    console.info(
      `[receipts/process] receipt ${receiptId} is already '${receipt.status}'; acking`,
    );
    return;
  }

  const settings = await deps.loadSettings(receipt.business_id ?? undefined);

  if (receipt.status === "queued") {
    const { error } = await supabase
      .from("receipts")
      .update({ status: "processing" })
      .eq("id", receiptId)
      .eq("status", "queued");
    if (error !== null) {
      console.error(`[receipts/process] could not claim receipt ${receiptId}`, error);
      return;
    }
  }

  // ---- Stages 3 and 4: signed URL, OCR, evidence -------------------------
  const attempt = await nextAttemptNumber(supabase, receiptId);

  let response: OcrResponse;
  try {
    response = await runOcr(deps, receipt, attempt);
  } catch (error) {
    await handleOcrFailure({ deps, receipt, attempt, settings, error });
    return;
  }

  const recorded = await recordOcrAttempt(supabase, receiptId, attempt, response);
  if (!recorded) return;
  await recordUsageEvent(supabase, receipt, attempt);

  // ---- Stages 5 to 7: templates, parse, matching -------------------------
  const templates = await loadTemplates(supabase, receipt.business_id);
  const template = selectTemplate(templates, response);
  const parsed = parseReceipt({
    rawText: response.rawText,
    blocks: response.blocks,
    ...(template === null ? {} : { config: template.config }),
  });

  const business = await loadBusiness(supabase, receipt.business_id);
  const candidates = buildMatchCandidates(business, templates, template);
  const match = matchBusiness({
    rawText: response.rawText,
    merchantName: parsed.merchantName,
    preBoundBusinessId: receipt.business_id,
    candidates,
    trigramSimilarity,
    thresholds: {
      accept: settings.routing.matchAccept,
      review: settings.routing.matchReview,
    },
  });
  const matchedBusinessId = match.businessId;

  // ---- Stage 8: validation -----------------------------------------------
  const businessVerifiedAt =
    business === null || business.verified_at === null
      ? null
      : new Date(business.verified_at);
  const validation = validateParsedReceipt({
    parsed,
    now: now(),
    maxAgeDays: settings.maxAgeDays,
    businessVerifiedAt,
  });

  // ---- Stage 8.5: fraud (doc 37) -----------------------------------------
  const customer = await loadCustomerPair(supabase, matchedBusinessId, receipt.user_id);
  const fraudSignals = await collectFraudSignals({
    deps,
    receipt,
    settings,
    parsed,
    response,
    matchedBusinessId,
    templateSourceKind: template?.sourceKind ?? null,
  });
  const signals = [...validation.signals, ...fraudSignals];
  const verdict = fraudVerdict(signals, settings.fraudReviewThreshold);

  // ---- Stage 9: confidence and routing -----------------------------------
  const confidence = parseConfidence({
    total: fieldSource(parsed.totalCentavos),
    date: fieldSource(parsed.receiptDate),
    receiptNumber: fieldSource(parsed.receiptNumber),
    meanOcrConfidence: response.meanConfidence,
    vatConsistent: parsed.vatConsistent,
  });

  // Doc 37 ladder step 3: a blacklisted customer's future receipts at that
  // business "force review". Checked HERE rather than after the award RPC
  // refuses with CUSTOMER_BLACKLISTED, because by then the receipt is already
  // 'approved' and would have to be walked backwards through a transition the
  // state machine does not draw.
  const blacklisted = customer?.segment === "blacklisted";
  const outcome = resolveOutcome({
    routed: routeReceipt({
      parseConfidence: confidence,
      matchConfidence: match.confidence,
      fraud: verdict,
      thresholds: settings.routing,
    }),
    validationRejection: validation.rejection,
    forceReview: validation.forceReview || blacklisted,
    matchedBusinessId,
  });

  // ---- Stage 10 preparation: price the receipt before writing 'approved' --
  //
  // Pricing runs BEFORE the terminal write and the award RPC runs after it,
  // because the two halves straddle that write: `processed_at` below depends
  // on whether points are due (0018 step 7 writes it on the awarding path),
  // and 0018 step 2 refuses anything not already 'approved'. Both halves are
  // ./award.ts, shared verbatim with the human review service.
  const award: AwardPlan | null =
    outcome.status === "approved" && matchedBusinessId !== null
      ? await priceReceipt({
          deps,
          businessId: matchedBusinessId,
          receipt: {
            id: receipt.id,
            createdAt: receipt.created_at,
            totalCentavos: parsed.totalCentavos,
            receiptDate: parsed.receiptDate,
          },
          isFirstVisit: (customer?.visit_count ?? 0) === 0,
        })
      : null;

  // ---- The single receipts write -----------------------------------------
  const parseMeta = buildParseMeta({
    parsed,
    match,
    template,
    response,
    attempt,
    confidence,
  });
  const persisted = await persistOutcome({
    supabase,
    receiptId,
    matchedBusinessId,
    parsed,
    templateId: template?.id ?? null,
    matchConfidence: match.confidence,
    parseConfidence: confidence,
    parseMeta,
    outcome,
    // Both RPCs set processed_at themselves (0018 step 7 on the awarding path,
    // 0023 step 3 on the zero-point visit path), so every priced approval
    // leaves it null here rather than writing it twice and having the two
    // values disagree by a few milliseconds. `award` is null on the review,
    // rejected and unmatched paths, which reach no RPC and stamp it here.
    processedAt: award !== null ? null : now(),
    now: now(),
  });

  const finalOutcome = persisted.outcome;
  if (persisted.duplicateNumber) {
    signals.push(
      buildSignal("receipt_number_live_conflict", {
        receipt_number: parsed.receiptNumber,
        detected_by: "receipts_number_unique",
      }),
    );
  }

  // ---- Evidence children (parent tenancy is now written) -----------------
  await writeFraudSignals(supabase, receipt, matchedBusinessId, signals);
  await writeLineItems(supabase, receipt.id, matchedBusinessId, parsed);

  // ---- Stage 10: the award ------------------------------------------------
  // The receipt is 'approved' in the database by now (`persistOutcome` above),
  // which is `awardPoints`'s stated precondition and 0018 step 2's guard.
  if (finalOutcome.status === "approved" && award !== null) {
    await awardPoints({ deps, receiptId: receipt.id, plan: award });
  }

  // ---- Doc 37 consequences ladder step 2 ---------------------------------
  // ./cooldown.ts, shared verbatim with the human review service, for the same
  // reason the award path is shared: one rule, one implementation.
  if (
    finalOutcome.status === "rejected" &&
    isFraudFamilyRejectReason(finalOutcome.reason)
  ) {
    await applyCooldownIfEarned(deps, receipt.user_id, settings);
  }

  console.info(
    `[receipts/process] receipt ${receiptId} -> ${finalOutcome.status}` +
      (finalOutcome.status === "rejected" ? ` (${finalOutcome.reason})` : "") +
      ` parse=${confidence} match=${match.confidence} signals=${signals.length}`,
  );
}

function fieldSource(value: unknown): FieldSource {
  // No LLM parse-assist tier at MVP (doc 36 Stage 7 tier 3 is [V1]), so every
  // extracted field is deterministic and therefore `validated`; `llm_assisted`
  // stays unused until that tier lands.
  return value === null || value === undefined ? "missing" : "validated";
}

// ---------------------------------------------------------------------------
// Outcome resolution
// ---------------------------------------------------------------------------

/**
 * Merge doc 36 Stage 8's terminal validation failures, doc 36 Stage 9's
 * confidence routing (already merged with doc 37's fraud table inside
 * `routeReceipt`), and the two "force a human to look" rules.
 *
 * Precedence, in order:
 *
 *  1. A fraud `block` outranks a validation rejection. It is the same argument
 *     confidence.ts makes for blocks outranking `unreadable`: a block is a
 *     deterministic statement about the SUBMISSION (this exact image or this
 *     exact number has been claimed already), while `too_old` or `unreadable`
 *     are statements about the paper or our own read of it. It is also the
 *     reason the cooldown ladder counts, and letting an abuser launder a
 *     duplicate into a softer reason by submitting a stale photo would be a
 *     hole.
 *  2. A validation rejection outranks everything else and is terminal.
 *  3. Otherwise the routed outcome, upgraded from `approved` to `review` when
 *     something demands a human (amount sanity, blacklisted customer).
 *  4. A `review` outcome with no business id is impossible by construction
 *     (match confidence 0 rejects as wrong_business first) and is converted
 *     anyway, because 0017 states the consequence in the schema itself: no RLS
 *     audience on this database can select a receipt whose business_id is
 *     null, so such a row would sit in a queue nobody can open, forever.
 */
export function resolveOutcome(input: {
  routed: RouteOutcome;
  validationRejection: ReceiptRejectReason | null;
  forceReview: boolean;
  matchedBusinessId: string | null;
}): RouteOutcome {
  const { routed, validationRejection, forceReview, matchedBusinessId } = input;

  let outcome: RouteOutcome = routed;
  if (routed.status === "rejected" && isFraudFamilyRejectReason(routed.reason)) {
    outcome = routed;
  } else if (validationRejection !== null) {
    outcome = { status: "rejected", reason: validationRejection };
  } else if (forceReview && routed.status === "approved") {
    outcome = { status: "review" };
  }

  if (outcome.status === "review" && matchedBusinessId === null) {
    return { status: "rejected", reason: "wrong_business" };
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// OCR stage
// ---------------------------------------------------------------------------

async function nextAttemptNumber(
  supabase: SupabaseClient<Database>,
  receiptId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("ocr_results")
    .select("attempt")
    .eq("receipt_id", receiptId)
    .order("attempt", { ascending: false })
    .limit(1);

  if (error !== null) {
    console.error(
      `[receipts/process] could not read attempt history for ${receiptId}`,
      error,
    );
  }
  const rows = (data ?? []) as Array<{ attempt: number }>;
  return (rows[0]?.attempt ?? 0) + 1;
}

async function runOcr(
  deps: ProcessReceiptDeps,
  receipt: ReceiptRow,
  attempt: number,
): Promise<OcrResponse> {
  const { data, error } = await deps.supabase.storage
    .from(RECEIPTS_BUCKET)
    .createSignedUrl(toObjectPath(receipt.image_path), SIGNED_URL_TTL_SECONDS);

  if (error !== null || data === null) {
    // Doc 36 "Retry, timeouts, DLQ" lists signed-URL expiry among the
    // RETRYABLE failures, and the image itself is never re-requested from the
    // consumer: a later attempt simply mints a fresh URL. Raised as an OcrError
    // so the attempt accounting below has one taxonomy to reason about.
    throw new OcrError("OCR_UNAVAILABLE", "Could not sign the receipt image URL", {
      retryable: true,
      ...(error === null ? {} : { cause: error }),
    });
  }

  return deps.ocr.ocr({
    // Correlates the container's log line with this exact attempt.
    requestId: `receipt-${receipt.id}-attempt-${attempt}`,
    imageUrl: data.signedUrl,
    preprocess: "auto",
    langs: ["en"],
    returnBlocks: true,
  });
}

async function recordOcrAttempt(
  supabase: SupabaseClient<Database>,
  receiptId: string,
  attempt: number,
  response: OcrResponse,
): Promise<boolean> {
  const { error } = await supabase.from("ocr_results").insert({
    receipt_id: receiptId,
    attempt,
    engine: response.engine,
    engine_version: response.engineVersion,
    raw_text: response.rawText,
    blocks: toJson(response.blocks),
    mean_confidence: toStoredConfidence(response.meanConfidence),
    preprocess_ops: response.preprocessOps,
    duration_ms: response.durationMs,
  });

  if (error === null) return true;

  if (isUniqueViolation(error)) {
    // UNIQUE (receipt_id, attempt) fired: another worker is already on this
    // attempt. Stop rather than racing it - doc 36 Stage 2's idempotency
    // contract is that a duplicate worker acks and exits.
    console.warn(
      `[receipts/process] attempt ${attempt} of receipt ${receiptId} already recorded; another worker owns it`,
    );
    return false;
  }
  console.error(
    `[receipts/process] could not record OCR attempt ${attempt} for ${receiptId}`,
    error,
  );
  return false;
}

/**
 * Doc 36 Stage 4: one `ai_usage_events` row per OCR call, so cost metering is
 * never retrofitted. `units=1` is one page.
 */
async function recordUsageEvent(
  supabase: SupabaseClient<Database>,
  receipt: ReceiptRow,
  attempt: number,
): Promise<void> {
  const { error } = await supabase.from("ai_usage_events").insert({
    business_id: receipt.business_id,
    user_id: receipt.user_id,
    kind: "ocr",
    units: 1,
    ref_id: receipt.id,
  });
  if (error !== null) {
    // Metering must never decide a receipt's fate: a lost meter row costs a
    // reporting cent, a failed receipt costs a customer.
    console.error(
      `[receipts/process] could not meter OCR attempt ${attempt} for ${receipt.id}`,
      error,
    );
  }
}

interface OcrFailureInput {
  deps: ProcessReceiptDeps;
  receipt: ReceiptRow;
  attempt: number;
  settings: ReceiptSettings;
  error: unknown;
}

/**
 * The `ocr_results.engine` value written for an attempt that FAILED, keyed by
 * which provider was selected. On a failure there is no response body to read
 * the engine name out of, so it is derived from the provider instead - and it
 * has to be derived, not guessed: an edge-provider failure recorded as
 * `paddleocr` would put rows in the OCR quality dashboards attributing our
 * VLM's error rate to an engine that has never run here.
 */
const FAILED_ATTEMPT_ENGINE: Record<OcrProvider["name"], string> = {
  stub: "stub",
  edge: "hf-vlm",
  http: "paddleocr",
};

/**
 * Doc 36 "Retry, timeouts, DLQ". Three outcomes, and the receipt is never left
 * in a state no future attempt can reach:
 *
 *   * IMAGE_UNREADABLE (422) is non-retryable and "falls through to the
 *     confidence/rejection path immediately" -> rejected / unreadable.
 *   * Any retryable failure with attempts left is left at status='processing',
 *     which doc 36 Stage 2 names as retry-eligible, so the next delivery
 *     resumes at the next attempt number.
 *   * Attempts exhausted -> rejected / manual with reject_note
 *     'processing_failed', the DLQ contract.
 */
async function handleOcrFailure(input: OcrFailureInput): Promise<void> {
  const { deps, receipt, attempt, settings, error } = input;
  const ocrError = error instanceof OcrError ? error : null;
  const code = ocrError?.code ?? "OCR_BAD_RESPONSE";
  // An unrecognized throw is treated as retryable: it is more likely a
  // transient fault than a permanent property of this image, and the attempt
  // budget bounds how long that optimism can last.
  const retryable = ocrError?.retryable ?? true;
  const message = error instanceof Error ? error.message : String(error);

  // Metered only when the service actually answered. A timeout or an
  // unreachable host consumed no page, and billing a call that never landed
  // would corrupt the very budget this meter exists to enforce.
  if (ocrError !== null && ocrError.status !== undefined) {
    await recordUsageEvent(deps.supabase, receipt, attempt);
  }

  // A24.1: `ocr_results.error` is per-attempt, which is exactly what makes
  // ocr.max_attempts countable. The row also keeps the attempt slot taken, so
  // a retry cannot silently reuse the number.
  const { error: insertError } = await deps.supabase.from("ocr_results").insert({
    receipt_id: receipt.id,
    attempt,
    // The engine that WOULD have answered. engine_version is genuinely unknown
    // on a failed call, and inventing one would pollute the version histogram
    // the OCR quality dashboards read.
    engine: FAILED_ATTEMPT_ENGINE[deps.ocr.name],
    engine_version: "unknown",
    error: `${code}: ${message}`,
  });
  if (insertError !== null && !isUniqueViolation(insertError)) {
    console.error(
      `[receipts/process] could not record failed OCR attempt ${attempt} for ${receipt.id}`,
      insertError,
    );
  }

  if (code === "OCR_IMAGE_UNREADABLE") {
    await finalizeWithoutParse(deps, receipt.id, {
      status: "rejected",
      reason: "unreadable",
    });
    return;
  }

  // An OPERATOR failure, not a receipt failure. The provider marks both of
  // these non-retryable because retrying the same call is pointless, and it is
  // right about the call - but that is a statement about the credential, not
  // about this photograph. Rejecting here would burn every receipt submitted
  // during a token rotation, and no consumer action could recover them, so
  // they wait at 'processing' until the environment is fixed. The attempt
  // budget deliberately does not apply.
  if (code === "OCR_AUTH_FAILED" || code === "OCR_MISCONFIGURED") {
    console.error(
      `[receipts/process] OCR credentials are wrong (${code}); receipt ${receipt.id} is parked at 'processing' until they are fixed`,
    );
    return;
  }

  if (!retryable || attempt >= settings.ocrMaxAttempts) {
    console.error(
      `[receipts/process] receipt ${receipt.id} exhausted OCR attempts (${attempt}/${settings.ocrMaxAttempts}): ${code}`,
    );
    await finalizeWithoutParse(
      deps,
      receipt.id,
      { status: "rejected", reason: "manual" },
      "processing_failed",
    );
    return;
  }

  console.warn(
    `[receipts/process] receipt ${receipt.id} OCR attempt ${attempt} failed retryably (${code}); leaving it processing`,
  );
}

async function finalizeWithoutParse(
  deps: ProcessReceiptDeps,
  receiptId: string,
  outcome: Extract<RouteOutcome, { status: "rejected" }>,
  rejectNote?: string,
): Promise<void> {
  const { error } = await deps.supabase
    .from("receipts")
    .update({
      status: outcome.status,
      reject_reason: outcome.reason,
      reject_note: rejectNote ?? null,
      processed_at: deps.now().toISOString(),
    })
    .eq("id", receiptId);
  if (error !== null) {
    console.error(
      `[receipts/process] could not finalize receipt ${receiptId} as ${outcome.reason}`,
      error,
    );
  }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadTemplates(
  supabase: SupabaseClient<Database>,
  businessId: string | null,
): Promise<TemplateRow[]> {
  if (businessId === null) return [];
  const { data, error } = await supabase
    .from("receipt_templates")
    .select("id, source_kind, parse_config")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .not("validated_at", "is", null)
    .is("deleted_at", null)
    .order("id", { ascending: true });

  if (error !== null) {
    // A template read failure degrades to the generic parse tier, which is a
    // worse parse, never a wrong one.
    console.error(
      `[receipts/process] could not load templates for business ${businessId}`,
      error,
    );
    return [];
  }
  return (data ?? []) as TemplateRow[];
}

interface BusinessRow {
  id: string;
  name: string;
  verified_at: string | null;
}

async function loadBusiness(
  supabase: SupabaseClient<Database>,
  businessId: string | null,
): Promise<BusinessRow | null> {
  if (businessId === null) return null;
  const { data, error } = await supabase
    .from("businesses")
    .select("id, name, verified_at")
    .eq("id", businessId)
    .maybeSingle<BusinessRow>();
  if (error !== null) {
    console.error(`[receipts/process] could not load business ${businessId}`, error);
    return null;
  }
  return data;
}

/**
 * Doc 36 Stage 5's candidate set.
 *
 * MVP is the pre-bound scan: the consumer scanned from a business page, so
 * there is exactly one candidate and matching runs as VERIFICATION. The
 * generic scan (no business_id, candidates scored across every active
 * business) is [V1] in doc 36 and is deliberately not implemented: with no
 * candidates `matchBusiness` returns a null business id, and `routeReceipt`
 * turns a match confidence of 0 into rejected / wrong_business - which is
 * precisely the behaviour 0017's own comment demands, rather than parking an
 * unmatchable receipt in a review queue no audience can read.
 */
function buildMatchCandidates(
  business: BusinessRow | null,
  templates: readonly TemplateRow[],
  selected: SelectedTemplate | null,
): MatchCandidate[] {
  if (business === null) return [];

  const aliases: string[] = [];
  let tin: string | null = null;
  for (const row of templates) {
    const config = sanitizeParseConfig(row.parse_config);
    aliases.push(...(config.merchant_aliases ?? []));
    if (tin === null && config.tin !== undefined) tin = config.tin;
  }

  return [
    {
      businessId: business.id,
      name: business.name,
      tin,
      merchantAliases: aliases,
      // Doc 36 Stage 5's "+0.05 for a validated-template structural match":
      // a template of this business won Stage 6 selection.
      hasValidatedTemplateMatch: selected !== null,
    },
  ];
}

interface CustomerPairRow {
  segment: string;
  visit_count: number;
}

async function loadCustomerPair(
  supabase: SupabaseClient<Database>,
  businessId: string | null,
  consumerId: string,
): Promise<CustomerPairRow | null> {
  if (businessId === null) return null;
  const { data, error } = await supabase
    .from("business_customers")
    .select("segment, visit_count")
    .eq("business_id", businessId)
    .eq("consumer_id", consumerId)
    .maybeSingle<CustomerPairRow>();
  if (error !== null) {
    console.error(
      `[receipts/process] could not load the customer pair for ${businessId}`,
      error,
    );
    return null;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Fraud detectors (doc 37 S1, S3, S4, S5, S7, S8, S9)
// ---------------------------------------------------------------------------

interface FraudInput {
  deps: ProcessReceiptDeps;
  receipt: ReceiptRow;
  settings: ReceiptSettings;
  parsed: ParsedReceipt;
  response: OcrResponse;
  matchedBusinessId: string | null;
  templateSourceKind: string | null;
}

async function collectFraudSignals(input: FraudInput): Promise<FraudSignal[]> {
  const signals: FraudSignal[] = [];

  signals.push(...(await detectImageHashDuplicate(input)));
  signals.push(...(await detectReceiptNumberDuplicate(input)));

  const counts = await collectVelocityCounts(
    input.deps.redis,
    velocityWindowSpecs({
      now: input.deps.now(),
      userId: input.receipt.user_id,
      businessId: input.matchedBusinessId,
      deviceId: input.receipt.device_id,
    }),
  );
  signals.push(...evaluateVelocity(counts, input.settings.velocityCaps));

  signals.push(...(await detectAmountAnomalies(input)));

  // S8: doc 36 Stage 9's trailing note. Never blocks; contextualizes review.
  if (shouldEmitLowConfidenceSignal(input.response.meanConfidence)) {
    signals.push(
      buildSignal("ai_mean_confidence_low", {
        mean_confidence: input.response.meanConfidence,
      }),
    );
  }

  signals.push(...(await detectStaffSelfScan(input)));

  return signals;
}

/**
 * S1 layer 2, the perceptual half (layer 1 is `receipts_sha_unique`, enforced
 * synchronously at submit and never reaching this pipeline).
 *
 * Candidate set is doc 37's MVP scope: the same consumer over all time, plus
 * the same business over 90 days. Platform-wide widening is [V1].
 *
 * Two readings the doc leaves open, decided here:
 *
 *   * Only the NEAREST neighbour produces a signal. `evidence` is specified as
 *     a single `matched_receipt_id`, one row per neighbour would flood the
 *     review UI on a busy store, and the nearest match dominates the composite
 *     anyway (a block beats every warn).
 *   * Receipts already in status 'rejected' are EXCLUDED from the candidate
 *     set, mirroring the live-status predicate of `receipts_number_unique`. A
 *     rejected receipt holds no claim on anything, and doc 36 is explicit that
 *     a consumer whose receipt was rejected "may resubmit"; without this
 *     exclusion a re-photograph of the same paper would be blocked as a
 *     duplicate of the very row that told them to try again.
 */
async function detectImageHashDuplicate(input: FraudInput): Promise<FraudSignal[]> {
  const { deps, receipt, settings, matchedBusinessId } = input;
  const hash = receipt.image_hash;
  if (hash.length === 0) return [];

  const neighbours = new Map<string, { id: string; user_id: string; image_hash: string }>();

  const consumerHistory = await deps.supabase
    .from("receipts")
    .select("id, user_id, image_hash")
    .eq("user_id", receipt.user_id)
    .neq("id", receipt.id)
    .neq("status", "rejected")
    .order("created_at", { ascending: false })
    .limit(PHASH_CANDIDATE_LIMIT);

  if (consumerHistory.error !== null) {
    console.error("[receipts/process] pHash consumer history read failed", consumerHistory.error);
  }
  for (const row of (consumerHistory.data ?? []) as Array<{
    id: string;
    user_id: string;
    image_hash: string;
  }>) {
    neighbours.set(row.id, row);
  }

  if (matchedBusinessId !== null) {
    const businessHistory = await deps.supabase
      .from("receipts")
      .select("id, user_id, image_hash")
      .eq("business_id", matchedBusinessId)
      .gte("created_at", daysAgo(deps.now(), PHASH_LOOKBACK_DAYS))
      .neq("id", receipt.id)
      .neq("status", "rejected")
      .order("created_at", { ascending: false })
      .limit(PHASH_CANDIDATE_LIMIT);

    if (businessHistory.error !== null) {
      console.error(
        "[receipts/process] pHash business history read failed",
        businessHistory.error,
      );
    }
    for (const row of (businessHistory.data ?? []) as Array<{
      id: string;
      user_id: string;
      image_hash: string;
    }>) {
      neighbours.set(row.id, row);
    }
  }

  let nearest: { id: string; userId: string; distance: number } | null = null;
  for (const row of neighbours.values()) {
    let distance: number;
    try {
      distance = hammingDistance(hash, row.image_hash);
    } catch {
      // A malformed stored hash is a data problem, not this receipt's problem.
      continue;
    }
    if (nearest === null || distance < nearest.distance) {
      nearest = { id: row.id, userId: row.user_id, distance };
    }
  }
  if (nearest === null) return [];

  const band = phashBand(nearest.distance, settings.phashBands);
  if (band === null) return [];

  return [
    buildSignal(
      band.severity === "block" ? "phash_near_identical" : "phash_similar",
      {
        matched_receipt_id: nearest.id,
        hamming_distance: nearest.distance,
        matched_consumer_id: nearest.userId,
        // Doc 37: a 0-4 match across consumers is simultaneously ring evidence.
        cross_consumer: nearest.userId !== receipt.user_id,
      },
    ),
  ];
}

/**
 * S3. `receipts_number_unique` is the DB backstop; this detector exists so the
 * conflict is EXPLAINED (which receipt, whose, live or already rejected)
 * rather than surfacing as a bare 23505, and so a cross-consumer conflict is
 * recorded as ring evidence.
 */
async function detectReceiptNumberDuplicate(input: FraudInput): Promise<FraudSignal[]> {
  const { deps, receipt, parsed, matchedBusinessId } = input;
  const number = parsed.receiptNumber;
  if (number === null || matchedBusinessId === null) return [];

  const { data, error } = await deps.supabase
    .from("receipts")
    .select("id, user_id, status")
    .eq("business_id", matchedBusinessId)
    .eq("receipt_number", number)
    .neq("id", receipt.id)
    .limit(50);

  if (error !== null) {
    console.error("[receipts/process] receipt-number duplicate read failed", error);
    return [];
  }

  const rows = (data ?? []) as Array<{ id: string; user_id: string; status: string }>;
  const live = rows.find((row) =>
    (LIVE_STATUSES as readonly string[]).includes(row.status),
  );
  const target = live ?? rows[0];
  if (target === undefined) return [];

  return [
    buildSignal(
      live === undefined
        ? "receipt_number_prior_rejected"
        : "receipt_number_live_conflict",
      {
        matched_receipt_id: target.id,
        receipt_number: number,
        matched_consumer_id: target.user_id,
        cross_consumer: target.user_id !== receipt.user_id,
      },
    ),
  ];
}

/**
 * S7. Two of the doc's three patterns are implemented here:
 *
 *   * Outlier total, via the template's `amount_sanity.max_total_centavos`.
 *     Doc 37's preferred input is the business's trailing-90d p99 of approved
 *     totals from a daily rollup; that rollup belongs to the analytics slice
 *     and does not exist, so the doc's own documented fallback is used.
 *   * Round-number abuse on handwritten pads.
 *
 * The third (total vs the sum of line items) is emitted as `info` when the
 * receipt carries a complete set of priced line items. PH receipts are
 * VAT-INCLUSIVE, so item prices already carry VAT and the sum is compared
 * against `total_centavos`, not against `subtotal_centavos`; the doc says only
 * "beyond VAT tolerance" and does not say which.
 */
async function detectAmountAnomalies(input: FraudInput): Promise<FraudSignal[]> {
  const { deps, receipt, parsed, matchedBusinessId, templateSourceKind } = input;
  const signals: FraudSignal[] = [];
  const total = parsed.totalCentavos;

  if (parsed.withinAmountSanity === false && total !== null) {
    signals.push(
      buildSignal("amount_outlier_total", {
        observed_centavos: total,
        source: "template_amount_sanity",
      }),
    );
  }

  if (total !== null && parsed.lineItems.length > 0) {
    const priced = parsed.lineItems.filter((item) => item.lineTotalCentavos !== null);
    if (priced.length === parsed.lineItems.length) {
      const sum = priced.reduce((acc, item) => acc + (item.lineTotalCentavos ?? 0), 0);
      const tolerance = Math.max(5, total * 0.005);
      if (Math.abs(sum - total) > tolerance) {
        signals.push(
          buildSignal("amount_total_vs_line_items", {
            observed_centavos: total,
            line_items_centavos: sum,
          }),
        );
      }
    }
  }

  if (
    templateSourceKind === "handwritten" &&
    matchedBusinessId !== null &&
    total !== null &&
    total % ROUND_NUMBER_MODULUS === 0
  ) {
    const { data, error } = await deps.supabase
      .from("receipts")
      .select("total_centavos")
      .eq("business_id", matchedBusinessId)
      .eq("user_id", receipt.user_id)
      .eq("status", "approved")
      .neq("id", receipt.id)
      .order("created_at", { ascending: false })
      .limit(ROUND_NUMBER_STREAK);

    if (error !== null) {
      console.error("[receipts/process] round-number streak read failed", error);
    } else {
      const rows = (data ?? []) as Array<{ total_centavos: number | null }>;
      const allRound =
        rows.length === ROUND_NUMBER_STREAK &&
        rows.every(
          (row) =>
            row.total_centavos !== null &&
            row.total_centavos % ROUND_NUMBER_MODULUS === 0,
        );
      if (allRound) {
        signals.push(
          buildSignal("amount_round_number_streak", {
            pattern: "round_numbers",
            streak: rows.length + 1,
          }),
        );
      }
    }
  }

  return signals;
}

/**
 * S9. Self-dealing staff are threat-model item 1. `business_staff.user_id` and
 * `receipts.user_id` are comparable because both ultimately key on
 * `profiles.id` (consumers.id references profiles.id, 0002).
 *
 * The signal's severity is `warn`, but `fraudVerdict` routes it to review
 * unconditionally, regardless of composite - which is why a receipt that is
 * perfect in every other respect still stops here.
 */
async function detectStaffSelfScan(input: FraudInput): Promise<FraudSignal[]> {
  const { deps, receipt, matchedBusinessId } = input;
  if (matchedBusinessId === null) return [];

  const { data, error } = await deps.supabase
    .from("business_staff")
    .select("id, role")
    .eq("business_id", matchedBusinessId)
    .eq("user_id", receipt.user_id)
    .eq("status", "active")
    .maybeSingle<{ id: string; role: string }>();

  if (error !== null) {
    console.error("[receipts/process] staff self-scan read failed", error);
    return [];
  }
  if (data === null) return [];

  return [
    buildSignal("staff_self_scan", {
      business_id: matchedBusinessId,
      staff_role: data.role,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function buildParseMeta(input: {
  parsed: ParsedReceipt;
  match: { confidence: number; contradicted: boolean };
  template: SelectedTemplate | null;
  response: OcrResponse;
  attempt: number;
  confidence: number;
}): Json {
  const tier = input.template === null ? "heuristic" : "template";
  // A24.2 asks for {field: {tier, conf}}. parse.ts does not report which tier
  // produced each individual field - it composes the template and generic
  // tiers inside one call - so `tier` here is the tier the parse RAN in, and
  // `present` is what the review UI's per-field chips actually key on.
  // Refining this to genuine per-field provenance is a parse.ts change and is
  // deliberately not smuggled into this orchestration.
  const field = (value: unknown): Json => ({ tier, present: value !== null });

  return toJson({
    engine: "parse/v1",
    template_id: input.template?.id ?? null,
    template_source_kind: input.template?.sourceKind ?? null,
    tier,
    parse_confidence: input.confidence,
    fields: {
      merchant_name: field(input.parsed.merchantName),
      receipt_number: field(input.parsed.receiptNumber),
      receipt_date: field(input.parsed.receiptDate),
      subtotal_centavos: field(input.parsed.subtotalCentavos),
      tax_centavos: field(input.parsed.taxCentavos),
      total_centavos: field(input.parsed.totalCentavos),
    },
    vat_consistent: input.parsed.vatConsistent,
    within_amount_sanity: input.parsed.withinAmountSanity,
    date_ambiguous: input.parsed.dateAmbiguous,
    notes: input.parsed.notes,
    match: {
      confidence: input.match.confidence,
      contradicted: input.match.contradicted,
    },
    ocr: {
      engine: input.response.engine,
      engine_version: input.response.engineVersion,
      mean_confidence: input.response.meanConfidence,
      attempt: input.attempt,
      preprocess_ops: input.response.preprocessOps,
    },
  });
}

interface PersistInput {
  supabase: SupabaseClient<Database>;
  receiptId: string;
  matchedBusinessId: string | null;
  parsed: ParsedReceipt;
  templateId: string | null;
  matchConfidence: number;
  parseConfidence: number;
  parseMeta: Json;
  outcome: RouteOutcome;
  processedAt: Date | null;
  now: Date;
}

/**
 * The one write that moves the receipt to its terminal status AND persists
 * every parsed field, both confidences and parse_meta - on the review and
 * rejected paths just as much as on the approved one, because the review UI
 * renders exactly those columns and a reviewer with an empty form is a
 * reviewer who cannot work.
 */
async function persistOutcome(
  input: PersistInput,
): Promise<{ outcome: RouteOutcome; duplicateNumber: boolean }> {
  const { parsed, outcome } = input;

  const payload = {
    business_id: input.matchedBusinessId,
    merchant_name: parsed.merchantName,
    receipt_number: parsed.receiptNumber,
    receipt_date: parsed.receiptDate?.toISOString() ?? null,
    subtotal_centavos: parsed.subtotalCentavos,
    tax_centavos: parsed.taxCentavos,
    total_centavos: parsed.totalCentavos,
    template_id: input.templateId,
    match_confidence: toStoredConfidence(input.matchConfidence),
    parse_confidence: toStoredConfidence(input.parseConfidence),
    parse_meta: input.parseMeta,
    status: outcome.status,
    reject_reason: outcome.status === "rejected" ? outcome.reason : null,
    processed_at: input.processedAt?.toISOString() ?? null,
  };

  const { error } = await input.supabase
    .from("receipts")
    .update(payload)
    .eq("id", input.receiptId);

  if (error === null) return { outcome, duplicateNumber: false };

  if (!isUniqueViolation(error)) {
    console.error(
      `[receipts/process] could not persist the outcome of receipt ${input.receiptId}`,
      error,
    );
    return { outcome, duplicateNumber: false };
  }

  // The only unique index this statement can violate is
  // `receipts_number_unique`: another receipt took a LIVE claim on this
  // (business_id, receipt_number) between our detector's read and this write.
  // The database has just told us the deterministic truth doc 37 S3 describes,
  // so honour it - and note that a 'rejected' row is outside the partial
  // index, which is exactly why the retry below can succeed.
  console.warn(
    `[receipts/process] receipt ${input.receiptId} lost a race on receipts_number_unique; rejecting as duplicate`,
  );
  const { error: retryError } = await input.supabase
    .from("receipts")
    .update({
      ...payload,
      status: "rejected",
      reject_reason: "duplicate",
      // The award path leaves processed_at null for the RPC to write; there is
      // no award now, so this rejection has to stamp it itself.
      processed_at: (input.processedAt ?? input.now).toISOString(),
    })
    .eq("id", input.receiptId);

  if (retryError !== null) {
    console.error(
      `[receipts/process] could not reject receipt ${input.receiptId} as a duplicate`,
      retryError,
    );
  }
  return {
    outcome: { status: "rejected", reason: "duplicate" },
    duplicateNumber: true,
  };
}

/**
 * Doc 37's philosophy line, implemented literally: every tripped detector
 * writes a row "including on receipts that end up approved". Scoring history
 * is how thresholds get tuned and slow-burn abusers get caught, so an approved
 * receipt's warn rows are the whole point rather than noise.
 *
 * One batch insert with `business_id` and `consumer_id` denormalized, per doc
 * 37's execution note (`fraud_signals_consumer_idx` serves the per-consumer
 * history the cooldown ladder reads).
 */
async function writeFraudSignals(
  supabase: SupabaseClient<Database>,
  receipt: ReceiptRow,
  matchedBusinessId: string | null,
  signals: readonly FraudSignal[],
): Promise<void> {
  if (signals.length === 0) return;

  const { error } = await supabase.from("fraud_signals").insert(
    signals.map((signal) => ({
      business_id: matchedBusinessId,
      receipt_id: receipt.id,
      consumer_id: receipt.user_id,
      signal: signal.signal,
      severity: signal.severity,
      score: signal.score,
      evidence: toJson(signal.evidence),
    })),
  );

  if (error !== null) {
    // Never fatal: the receipt's outcome is already written and correct. A
    // lost signal row costs future tuning accuracy, not this consumer's points.
    console.error(
      `[receipts/process] could not write fraud signals for receipt ${receipt.id}`,
      error,
    );
  }
}

/**
 * Doc 36 Stage 7's line items. Deleted and re-inserted rather than merged
 * because a reprocess re-parses from a NEW OCR attempt and the previous split
 * is not evidence - 0017 says so in as many words, which is why service_role
 * keeps delete on this table and not on `ocr_results` or `fraud_signals`.
 *
 * `product_id` fuzzy linkage against the business's catalogue is deliberately
 * left null: doc 36 states plainly that line items are analytics enrichment
 * and "never a gate on approval", so the trigram product match belongs with
 * the analytics work rather than in the award path.
 */
async function writeLineItems(
  supabase: SupabaseClient<Database>,
  receiptId: string,
  matchedBusinessId: string | null,
  parsed: ParsedReceipt,
): Promise<void> {
  const { error: deleteError } = await supabase
    .from("receipt_line_items")
    .delete()
    .eq("receipt_id", receiptId);
  if (deleteError !== null) {
    console.error(
      `[receipts/process] could not clear line items for receipt ${receiptId}`,
      deleteError,
    );
    return;
  }

  if (parsed.lineItems.length === 0) return;

  const { error } = await supabase.from("receipt_line_items").insert(
    parsed.lineItems.map((item) => ({
      business_id: matchedBusinessId,
      receipt_id: receiptId,
      raw_text: item.rawText,
      qty: item.qty,
      unit_price_centavos: item.unitPriceCentavos,
      line_total_centavos: item.lineTotalCentavos,
      sort: item.sort,
    })),
  );
  if (error !== null) {
    console.error(
      `[receipts/process] could not write line items for receipt ${receiptId}`,
      error,
    );
  }
}
