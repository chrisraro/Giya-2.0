import "server-only";

import { z } from "zod";

import { getServerEnv } from "@/lib/env";

import {
  GROQ_CHAT_COMPLETIONS_URL,
  TASK_MODELS,
  computeCostMicros,
  estimateCostMicros,
  getLlmModel,
  isLlmModelId,
} from "./models";
import type { LlmModelId } from "./models";

// =============================================================================
// The single LLM entry point.
// =============================================================================
//
// docs/30-modules/38-ai-rag-platform.md section 1: "Every model call in Giya
// goes through one module: src/lib/ai/llm.ts. No feature imports the Groq SDK
// directly." This is that module. The provider is reached with plain `fetch`
// against its OpenAI-compatible endpoint, so there is no SDK to import
// anywhere, here or elsewhere.
//
// -----------------------------------------------------------------------------
// THE CONTRACT: FAIL SOFT. THIS MODULE NEVER THROWS.
// -----------------------------------------------------------------------------
//
// Every exported function returns `null` on every failure path, without
// exception: no API key, malformed env, network refused, DNS failure, timeout,
// 401, 429 with the retry budget exhausted, 500, a non-JSON body, a body that
// does not match the caller's schema, a reasoning model that returns an empty
// answer, a bug in this file. All of it is `null`.
//
// This is not defensive habit, it is the safety property the whole extraction
// slice rests on. The receipt pipeline's parse tiers 1 and 2 are deterministic
// (docs/30-modules/36-receipt-ocr-pipeline.md Stage 7) and the LLM is tier 3,
// invoked only for fields the deterministic tiers left empty. Golden rule 5,
// docs/README.md: AI augments, never decides. If an LLM failure could throw,
// then Groq being out of quota on a Tuesday would take down receipt scanning
// for every business, and a pipeline that could otherwise have routed the
// receipt to the merchant's review queue instead loses it to an exception.
// `null` means "the LLM had nothing to add", which is a state the pipeline
// already knows how to handle, because it is the same state as "tier 3 was
// never called". There is a test named for this contract; keep it passing.
//
// The mirror of that rule: `null` never means "safe" or "zero" or "empty
// string". A caller must not read a null as a value. This is why the reasoning
// model trap below is handled explicitly.
//
// -----------------------------------------------------------------------------
// What this module does NOT do
// -----------------------------------------------------------------------------
//
// It does not touch the database. Doc 38 section 1 has the gateway writing
// `ai_usage_events` itself; here the usage is handed to an optional `meter`
// callback and the caller writes the row. The pipeline already owns a
// service-role client, a `receipts.id` for `ref_id`, the `business_id` and the
// transaction those belong in; duplicating that here would put a second writer
// on the money-adjacent path and would make this module untestable without a
// database. The metering CONTENT is doc 38's verbatim (kind, model, units,
// cost_micros); only the INSERT lives elsewhere.

// -----------------------------------------------------------------------------
// Timeouts and budgets
// -----------------------------------------------------------------------------

/**
 * Per-attempt wall clock.
 *
 * Doc 36's end-to-end budget is p95 < 60s for submit to award, and the OCR
 * stage alone is allowed 30s of it (`OCR_WORKER_TIMEOUT_MS` in
 * src/features/receipts/server/ocr/http.ts). Parse-assist is a gap filler that
 * runs after OCR inside the same budget, so it gets a small slice of what is
 * left.
 *
 * A parse-assist call is ~1.5K prompt tokens and ~300 completion tokens (doc 38
 * section 10), which this provider answers in one to two seconds. 8s is roughly
 * four times the expected latency: wide enough that ordinary jitter does not
 * abandon a call that was about to succeed, tight enough that a wedged provider
 * costs the pipeline 8s rather than a minute.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 8_000;

/**
 * Total wall clock across all attempts and all backoff sleeps.
 *
 * Doc 38 section 1 budgets "total <= 10s non-streaming", which was written for
 * the consumer assistant, where a person is watching a spinner. Parse-assist
 * has no watcher: it runs inside an already-async pipeline whose own budget is
 * 60s. Holding it to 10s would mean a single 429 (the free-tier failure mode
 * this account will actually hit, per the spec's free-tier caveat) leaves no
 * room to retry, and the receipt goes to human review over a rate limit that
 * would have cleared in two seconds.
 *
 * 20s buys the retry and still leaves the pipeline a third of its budget after
 * a 30s OCR worst case. The cap is enforced as a hard deadline, not as
 * attempts x timeout, so no combination of retries and Retry-After sleeps can
 * exceed it.
 */
export const DEFAULT_TOTAL_BUDGET_MS = 20_000;

/** Initial call plus two retries, bounded by the deadline above. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Enough for the receipt-parse schema with line items; clamped per model. */
export const DEFAULT_MAX_TOKENS = 1_024;

/** Extraction is a reading task, not a creative one. */
export const DEFAULT_TEMPERATURE = 0;

const BACKOFF_BASE_MS = 400;
const BACKOFF_MAX_MS = 4_000;

/**
 * Below this much remaining budget an attempt is not worth starting: it can
 * only end in a timeout, and it would spend the caller's deadline to learn
 * nothing.
 */
const MIN_USEFUL_ATTEMPT_MS = 500;

const LOG_PREFIX = "[llm]";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/** The `ai_usage_events.kind` check constraint, migration 0017_receipts.sql. */
export type AiUsageKind = "chat" | "embedding" | "ocr" | "parse_assist" | "analytics";

/**
 * One call's consumption, shaped so the caller can build an `ai_usage_events`
 * insert without re-deriving anything (doc 38 section 1). `units` is the column
 * of that name and is total tokens; `costMicros` is `cost_micros` and comes
 * from the registry.
 */
export interface LlmUsage {
  readonly kind: AiUsageKind;
  readonly model: LlmModelId;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** `ai_usage_events.units`: total tokens. */
  readonly units: number;
  /** `ai_usage_events.cost_micros`, from the registry. Integer, >= 0. */
  readonly costMicros: number;
  readonly latencyMs: number;
  /** How many HTTP attempts it took. > 1 means retries were spent. */
  readonly attempts: number;
}

/**
 * Called once per provider response that reported usage, whether or not the
 * answer turned out to be usable. Tokens burned by a response this module then
 * discards (schema mismatch, truncation, the reasoning trap) are still tokens
 * billed, and a meter that hides them under-reports exactly the failures worth
 * seeing.
 *
 * A call that never reached the provider (missing key, budget refusal, DNS
 * failure) has nothing to meter and does not fire this.
 *
 * May be async, and is awaited so the caller's row is written before the value
 * is returned. It is wrapped in try/catch: a meter that throws must not break
 * the fail-soft contract, and must not turn a good answer into a null one.
 */
export type LlmMeter = (usage: LlmUsage) => void | Promise<void>;

/** Test seams, mirroring the shape of the OCR http client's config. */
interface LlmSeams {
  /** Injected in tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injected in tests so backoff is asserted rather than waited out. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

export interface LlmCallOptions extends LlmSeams {
  /** Registry id. Defaults to the `parse_assist` task model, or `GROQ_MODEL`. */
  readonly model?: LlmModelId;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Per-attempt timeout. Defaults to DEFAULT_ATTEMPT_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /** Hard deadline across all attempts. Defaults to DEFAULT_TOTAL_BUDGET_MS. */
  readonly totalBudgetMs?: number;
  readonly maxAttempts?: number;
  /** `ai_usage_events.kind` for this call. Defaults to `parse_assist`. */
  readonly kind?: AiUsageKind;
  readonly meter?: LlmMeter;
  /**
   * Doc 38 section 10 budget cap, expressed as the tenant's REMAINING daily
   * allowance in micro-USD. When the worst-case estimated cost of this call
   * exceeds it, the provider is never contacted and the call returns null.
   *
   * The number is passed in rather than read here because it comes from a
   * rollup of `ai_usage_events` (Postgres is truth, per doc 38 section 1), and
   * this module does not read the database. Omitted means unbudgeted.
   */
  readonly budgetMicros?: number;
}

export interface CompleteJsonRequest<T> extends LlmCallOptions {
  /** The user-role message. Build it in a pure module; do not build it here. */
  readonly prompt: string;
  /** The caller's contract. A response that fails it is discarded, not coerced. */
  readonly schema: z.ZodType<T>;
  /** Optional extra system instruction, prepended to the JSON-mode instruction. */
  readonly system?: string;
}

export interface InjectionScreenResult {
  readonly flagged: boolean;
  /** Present only when the classifier returned a numeric probability. */
  readonly score?: number;
}

// -----------------------------------------------------------------------------
// Provider wire format (OpenAI-compatible), validated rather than trusted
// -----------------------------------------------------------------------------

// Same reasoning as the OCR http client: this is a third-party service we do
// not deploy in lockstep with. A renamed field or an HTML error page served
// with a 200 must produce a clean null, not `undefined.trim()` three frames
// deeper. Unknown keys are ignored, so the provider adding fields is not an
// outage.
const usageSchema = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
});

const messageSchema = z.object({
  content: z.string().nullable().optional(),
  // The trap. Some models on this provider are reasoning models: they spend
  // the completion budget here and leave `content` empty. Modelled explicitly
  // so it can be detected instead of silently read as an empty answer.
  reasoning: z.string().nullable().optional(),
});

const choiceSchema = z.object({
  message: messageSchema,
  finish_reason: z.string().nullable().optional(),
});

const completionSchema = z.object({
  choices: z.array(choiceSchema).min(1),
  usage: usageSchema.optional(),
});

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

interface ChatOutcome {
  readonly content: string;
  readonly usage: LlmUsage;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Equal jitter: half the exponential delay plus a random half. Deterministic
 * backoff synchronizes every worker that got rate limited by the same burst
 * into retrying together, which is how a 429 becomes a sustained 429.
 */
function backoffMs(attemptIndex: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attemptIndex);
  const half = ceiling / 2;
  return Math.round(half + Math.random() * half);
}

/** `Retry-After` is either delta-seconds or an HTTP date. Both are honoured. */
function parseRetryAfterMs(header: string | null): number | null {
  if (header === null) return null;

  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds <= 0 ? 0 : Math.round(seconds * 1_000);
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;

  return Math.max(0, date - Date.now());
}

/**
 * Retry classification, deliberately narrow.
 *
 * 429 and 5xx are "not now, ask again" and are the whole reason a retry budget
 * exists on a free-tier key. 408 is the provider timing itself out, same class.
 * Everything else in the 4xx range is a bug in the request we just built: a
 * malformed body (400), a bad or revoked key (401/403), an unknown model (404),
 * a schema the provider rejected (422). Retrying an identical bad request
 * cannot change the answer; it only spends the deadline before returning the
 * same null.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function resolveApiKey(): string | null {
  try {
    const key = getServerEnv().GROQ_API_KEY;
    return key === undefined || key.length === 0 ? null : key;
  } catch (error) {
    // getServerEnv throws when ANY required server key is missing, including
    // ones with nothing to do with the LLM (Redis, the redemption secret). A
    // misconfigured unrelated key must not throw out of this module, so the
    // whole read is guarded.
    console.warn(`${LOG_PREFIX} server env is unreadable; skipping the LLM call`, error);
    return null;
  }
}

/**
 * The default model: `GROQ_MODEL` when it names a registry entry, else the
 * `parse_assist` task model. An env value that is not in the registry is
 * ignored loudly rather than passed through, because an unregistered model has
 * no price and would be metered at zero.
 */
function resolveDefaultModel(): LlmModelId {
  let configured: string | undefined;
  try {
    configured = getServerEnv().GROQ_MODEL;
  } catch {
    configured = undefined;
  }

  if (configured !== undefined && configured.length > 0) {
    if (isLlmModelId(configured)) return configured;
    console.warn(
      `${LOG_PREFIX} GROQ_MODEL "${configured}" is not in the model registry; using the task default`,
    );
  }

  return TASK_MODELS.parse_assist;
}

async function reportUsage(meter: LlmMeter | undefined, usage: LlmUsage): Promise<void> {
  if (meter === undefined) return;
  try {
    await meter(usage);
  } catch (error) {
    // The caller's DB write failed. That is a metering problem, not an
    // extraction problem, and it must not cost the pipeline an answer it has
    // already paid for.
    console.error(`${LOG_PREFIX} metering callback threw; usage not recorded`, error);
  }
}

interface ChatRequest extends LlmCallOptions {
  readonly messages: readonly ChatMessage[];
  readonly jsonMode: boolean;
  /** Characters of prompt, for the pre-call budget estimate. */
  readonly promptChars: number;
}

/**
 * One chat completion, with retries, the deadline, validation and metering.
 * Returns the assistant's text, or null. Never throws: the try/catch around
 * the body is the last line of the fail-soft contract, covering a bug in this
 * function itself.
 */
async function chat(request: ChatRequest): Promise<ChatOutcome | null> {
  const startedAt = Date.now();

  try {
    const model = request.model ?? resolveDefaultModel();
    const entry = getLlmModel(model);
    const kind: AiUsageKind = request.kind ?? "parse_assist";
    const maxTokens = Math.max(
      1,
      Math.min(request.maxTokens ?? DEFAULT_MAX_TOKENS, entry.maxOutputTokens),
    );
    const temperature = request.temperature ?? DEFAULT_TEMPERATURE;
    const attemptTimeoutMs = request.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    const maxAttempts = Math.max(1, request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const deadline = startedAt + (request.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS);
    const doFetch = request.fetchImpl ?? globalThis.fetch;
    const sleep = request.sleepImpl ?? defaultSleep;

    const apiKey = resolveApiKey();
    if (apiKey === null) {
      // The documented dormant state, exactly like the OCR container before
      // its credentials landed: without a key the deterministic tiers simply
      // stand alone. Not an error, and not worth an error-level log on every
      // receipt.
      console.warn(`${LOG_PREFIX} GROQ_API_KEY is not configured; skipping the LLM call`);
      return null;
    }

    if (request.budgetMicros !== undefined) {
      const estimate = estimateCostMicros(model, request.promptChars, maxTokens);
      if (estimate > request.budgetMicros) {
        console.warn(
          `${LOG_PREFIX} estimated cost ${estimate} micros exceeds the remaining budget ${request.budgetMicros}; skipping the LLM call`,
        );
        return null;
      }
    }

    const body = JSON.stringify({
      model,
      messages: request.messages,
      temperature,
      max_tokens: maxTokens,
      ...(request.jsonMode ? { response_format: { type: "json_object" } } : {}),
    });

    let attempts = 0;

    while (attempts < maxAttempts) {
      const remaining = deadline - Date.now();
      if (remaining < MIN_USEFUL_ATTEMPT_MS) {
        console.warn(`${LOG_PREFIX} out of time budget after ${attempts} attempt(s)`);
        return null;
      }

      attempts += 1;

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, Math.min(attemptTimeoutMs, remaining));

      let response: Response;
      try {
        response = await doFetch(GROQ_CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body,
          signal: controller.signal,
        });
      } catch (cause) {
        // A timeout, or DNS/TLS/socket. Both mean "not reachable right now",
        // which is the same retryable class as a 503.
        console.warn(
          `${LOG_PREFIX} attempt ${attempts} failed (${timedOut ? "timeout" : "network"})`,
          cause,
        );
        if (attempts >= maxAttempts) return null;
        if (!(await waitBeforeRetry(sleep, backoffMs(attempts - 1), deadline))) return null;
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const retryable = isRetryableStatus(response.status);
        console.warn(
          `${LOG_PREFIX} attempt ${attempts} returned status ${response.status} (retryable=${retryable})`,
        );
        if (!retryable || attempts >= maxAttempts) return null;

        const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
        const delay = retryAfter ?? backoffMs(attempts - 1);
        if (!(await waitBeforeRetry(sleep, delay, deadline))) return null;
        continue;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (cause) {
        console.warn(`${LOG_PREFIX} provider returned a non-JSON body`, cause);
        return null;
      }

      const parsed = completionSchema.safeParse(payload);
      if (!parsed.success) {
        // Not retried: a shape mismatch is a provider or deployment change,
        // and the next attempt gets an identically shaped body.
        console.warn(
          `${LOG_PREFIX} provider returned an unexpected body: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
        );
        return null;
      }

      const [choice] = parsed.data.choices;
      if (choice === undefined) {
        // Unreachable given the schema's min(1), but the compiler cannot see
        // that and a throw here would break the fail-soft contract.
        console.warn(`${LOG_PREFIX} provider returned no choices`);
        return null;
      }

      const promptTokens = parsed.data.usage?.prompt_tokens ?? 0;
      const completionTokens = parsed.data.usage?.completion_tokens ?? 0;
      const usage: LlmUsage = {
        kind,
        model,
        promptTokens,
        completionTokens,
        units: parsed.data.usage?.total_tokens ?? promptTokens + completionTokens,
        costMicros: computeCostMicros(model, promptTokens, completionTokens),
        latencyMs: Date.now() - startedAt,
        attempts,
      };

      // Metered before any judgement about usability: these tokens are billed
      // whatever this function decides next.
      await reportUsage(request.meter, usage);

      const content = choice.message.content ?? "";
      const reasoning = choice.message.reasoning ?? "";

      // THE REASONING MODEL TRAP. Measured on this provider 2026-07-26: some
      // models put their whole answer in `message.reasoning`, leave `content`
      // empty and report finish_reason "length" because the reasoning ate the
      // completion budget. Returning "" here would hand the caller a value that
      // looks like a successful empty answer, and a caller that trusted it
      // would treat "no total found" as fact. It is a failure and it says so.
      if (content.trim().length === 0 && reasoning.trim().length > 0) {
        console.error(
          `${LOG_PREFIX} model "${model}" returned an empty content with ${reasoning.length} characters of reasoning (finish_reason=${choice.finish_reason ?? "none"}). This is a reasoning model; it is not usable for constrained extraction. Change the registry entry.`,
        );
        return null;
      }

      if (content.trim().length === 0) {
        console.warn(`${LOG_PREFIX} model "${model}" returned an empty content`);
        return null;
      }

      // A truncated completion is not a partial answer, it is an answer with
      // an unknown amount missing. For JSON it would fail to parse anyway; for
      // the classifier it could flip a verdict. Refused either way.
      if (choice.finish_reason === "length") {
        console.warn(
          `${LOG_PREFIX} model "${model}" hit the completion limit (finish_reason=length); discarding a truncated answer`,
        );
        return null;
      }

      return { content, usage };
    }

    return null;
  } catch (unexpected) {
    // The fail-soft backstop. Nothing above is expected to throw; if something
    // does, the pipeline still gets a null rather than an exception.
    console.error(`${LOG_PREFIX} unexpected failure; returning null`, unexpected);
    return null;
  }
}

/**
 * Sleep before a retry, unless the sleep would not leave room for the attempt
 * it precedes. Returns false when the caller should give up. This is what makes
 * `Retry-After: 120` a fast null instead of a two-minute hang.
 */
async function waitBeforeRetry(
  sleep: (ms: number) => Promise<void>,
  delayMs: number,
  deadline: number,
): Promise<boolean> {
  if (Date.now() + delayMs + MIN_USEFUL_ATTEMPT_MS > deadline) {
    console.warn(`${LOG_PREFIX} a ${delayMs}ms backoff would exceed the time budget; giving up`);
    return false;
  }
  if (delayMs > 0) await sleep(delayMs);
  return true;
}

/**
 * Models wrap JSON in a fenced code block often enough that refusing it would
 * discard good answers over punctuation. Nothing more permissive than this:
 * hunting for a brace inside prose is how a model's aside gets parsed as data.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;

  const withoutOpen = trimmed.replace(/^```[a-zA-Z]*\s*\n?/, "");
  const closing = withoutOpen.lastIndexOf("```");
  return (closing === -1 ? withoutOpen : withoutOpen.slice(0, closing)).trim();
}

// -----------------------------------------------------------------------------
// completeJson
// -----------------------------------------------------------------------------

/**
 * The JSON-mode instruction. `response_format: json_object` on this
 * OpenAI-compatible API requires the word JSON to appear in the messages, so
 * this is a protocol requirement as much as a prompt.
 */
const JSON_SYSTEM_INSTRUCTION =
  "You respond with a single valid JSON object and nothing else. " +
  "No prose, no markdown, no code fence, no explanation. " +
  "If a value cannot be determined, use null for it rather than guessing.";

/**
 * A chat completion constrained to JSON, parsed and validated against the
 * caller's Zod schema.
 *
 * Returns the validated value, or **null** for every failure: no key, budget
 * refused, timeout, 401, exhausted 429s, 5xx, non-JSON body, JSON that does not
 * satisfy `schema`, an empty answer, a truncated answer, or a reasoning model
 * that answered into `message.reasoning`. It never throws and never returns a
 * partially valid object; doc 38 section 8 is explicit that a schema violation
 * is discarded whole and routed to human review, never partially trusted.
 */
export async function completeJson<T>(request: CompleteJsonRequest<T>): Promise<T | null> {
  const system =
    request.system === undefined
      ? JSON_SYSTEM_INSTRUCTION
      : `${request.system}\n\n${JSON_SYSTEM_INSTRUCTION}`;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: request.prompt },
  ];

  const outcome = await chat({
    ...request,
    messages,
    jsonMode: true,
    promptChars: system.length + request.prompt.length,
  });

  if (outcome === null) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(stripCodeFence(outcome.content));
  } catch {
    console.warn(`${LOG_PREFIX} model returned content that is not valid JSON`);
    return null;
  }

  const parsed = request.schema.safeParse(payload);
  if (!parsed.success) {
    console.warn(
      `${LOG_PREFIX} model output failed the caller's schema: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
    return null;
  }

  return parsed.data;
}

// -----------------------------------------------------------------------------
// screenForInjection
// -----------------------------------------------------------------------------

/** A probability at or above this reads as an attempted injection. */
export const INJECTION_SCORE_THRESHOLD = 0.5;

/**
 * The classifier's context is 512 tokens (registry). Windows are sized in
 * characters at roughly three per token, well inside the window even for the
 * digit-dense text a receipt produces, where the usual four-characters-per-token
 * rule is optimistic.
 */
const SCREEN_WINDOW_CHARS = 1_200;

/**
 * Windows overlap so an injected sentence straddling a boundary is still seen
 * whole by at least one window. A little longer than the instruction stems the
 * classifier is trained on.
 */
const SCREEN_OVERLAP_CHARS = 200;

/**
 * A ceiling on calls per screen. Receipt OCR text is a few hundred to a couple
 * of thousand characters, so this is never reached in practice; it exists so a
 * pathological input cannot turn one screen into fifty classifier calls.
 */
const SCREEN_MAX_WINDOWS = 6;

const SCREEN_MAX_TOKENS = 16;

export function splitForScreening(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= SCREEN_WINDOW_CHARS) return [trimmed];

  const stride = SCREEN_WINDOW_CHARS - SCREEN_OVERLAP_CHARS;
  const windows: string[] = [];
  for (
    let start = 0;
    start < trimmed.length && windows.length < SCREEN_MAX_WINDOWS;
    start += stride
  ) {
    windows.push(trimmed.slice(start, start + SCREEN_WINDOW_CHARS));
  }
  return windows;
}

const verdictObjectSchema = z.object({
  label: z.string().optional(),
  score: z.number().optional(),
});

const FLAG_WORDS = ["jailbreak", "injection", "malicious", "unsafe", "attack"];
const BENIGN_WORDS = ["benign", "safe", "negative", "clean"];

/**
 * Read one classifier answer.
 *
 * Prompt Guard is a classifier served through a chat endpoint, and exactly what
 * it puts in `content` was not verifiable without spending a live call, so this
 * accepts the plausible encodings rather than betting on one: a bare
 * probability, a bare 0/1, a label word, or a small JSON object carrying either.
 * Anything it cannot read confidently is **null**, not "benign". Guessing
 * "benign" on an unrecognized answer would silently disable a security control;
 * null tells the caller the screen did not run, which routes the receipt to
 * review (spec section 4.2).
 */
export function parseInjectionVerdict(content: string): InjectionScreenResult | null {
  const raw = stripCodeFence(content);
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith("{")) {
    try {
      const parsed = verdictObjectSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) {
        const { label, score } = parsed.data;
        if (score !== undefined) {
          return { flagged: score >= INJECTION_SCORE_THRESHOLD, score };
        }
        if (label !== undefined) {
          const fromLabel = verdictFromWords(label);
          if (fromLabel !== null) return fromLabel;
        }
      }
    } catch {
      // Falls through to the textual readings below.
    }
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 1) {
    return { flagged: numeric >= INJECTION_SCORE_THRESHOLD, score: numeric };
  }

  return verdictFromWords(trimmed);
}

function verdictFromWords(value: string): InjectionScreenResult | null {
  const lowered = value.toLowerCase();
  if (FLAG_WORDS.some((word) => lowered.includes(word))) return { flagged: true };
  if (BENIGN_WORDS.some((word) => lowered.includes(word))) return { flagged: false };
  return null;
}

/** `maxTokens` and `temperature` are fixed: a classifier is not tunable here. */
export type ScreenForInjectionOptions = Omit<LlmCallOptions, "maxTokens" | "temperature">;

/**
 * Screen text for prompt injection with `meta-llama/llama-prompt-guard-2-86m`.
 *
 * Spec section 4.2: OCR text is attacker-controlled (anyone can print a receipt
 * carrying "IGNORE PREVIOUS INSTRUCTIONS"), so it is screened before extraction
 * and a positive result raises `ai_confidence_low` and routes to review rather
 * than being silently dropped.
 *
 * Returns `{flagged, score?}`, or **null** meaning "the screen did not run".
 * Null is not a pass. Text longer than the classifier's window is screened in
 * overlapping windows rather than truncated, because an injected line below a
 * truncation point would never be looked at, and it returns on the first
 * flagged window. If any window fails while none has flagged, the whole screen
 * is null: a partial screen must not be reported as a clean one.
 */
export async function screenForInjection(
  text: string,
  options: ScreenForInjectionOptions = {},
): Promise<InjectionScreenResult | null> {
  const windows = splitForScreening(text);
  if (windows.length === 0) {
    // Nothing to screen is not an injection, and it is not a failed screen
    // either. There is no text for an attacker to have written.
    return { flagged: false };
  }

  const deadline = Date.now() + (options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS);
  let bestScore: number | undefined;

  for (const window of windows) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_USEFUL_ATTEMPT_MS) {
      console.warn(`${LOG_PREFIX} injection screen ran out of time budget`);
      return null;
    }

    const outcome = await chat({
      ...options,
      model: options.model ?? TASK_MODELS.injection_screen,
      kind: options.kind ?? "parse_assist",
      messages: [{ role: "user", content: window }],
      jsonMode: false,
      maxTokens: SCREEN_MAX_TOKENS,
      temperature: 0,
      totalBudgetMs: remaining,
      promptChars: window.length,
    });

    if (outcome === null) return null;

    const verdict = parseInjectionVerdict(outcome.content);
    if (verdict === null) {
      console.warn(
        `${LOG_PREFIX} could not read the injection classifier's answer; treating the screen as not run`,
      );
      return null;
    }

    if (verdict.flagged) return verdict;

    if (verdict.score !== undefined) {
      bestScore = bestScore === undefined ? verdict.score : Math.max(bestScore, verdict.score);
    }
  }

  return bestScore === undefined ? { flagged: false } : { flagged: false, score: bestScore };
}

// Re-exported so features have a single import for the gateway and the registry
// that governs it (doc 38 section 1: features address a task, never a model).
export {
  GROQ_CHAT_COMPLETIONS_URL,
  LLM_MODELS,
  TASK_MODELS,
  computeCostMicros,
  estimateCostMicros,
  getLlmModel,
  isLlmModelId,
} from "./models";
export type { LlmModelEntry, LlmModelId, LlmTask } from "./models";
