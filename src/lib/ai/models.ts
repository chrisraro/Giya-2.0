// The LLM model registry that docs/30-modules/38-ai-rag-platform.md section 1
// mandates: "Config, not code - src/lib/ai/models.ts, one entry per task, so
// features never name models." Swapping a model is an edit to this file and
// nothing else; no feature code changes, which is the contract that makes the
// eventual vLLM move real rather than aspirational.
//
// Deliberately free of "server-only" and of any provider code. It is pure data
// plus arithmetic, so the metering maths is testable without a network, and a
// future admin cost screen can import it from anywhere.

/** Groq's OpenAI-compatible base, verified 2026-07-26. */
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/** The one endpoint this platform calls. */
export const GROQ_CHAT_COMPLETIONS_URL = `${GROQ_BASE_URL}/chat/completions`;

export interface LlmModelEntry {
  /** Exact provider model id, pinned (doc 38 section 12: no silent model drift). */
  readonly id: string;
  /** Doc 38 section 1: the registry carries the provider so a swap is a registry edit. */
  readonly provider: "groq";
  /** Total context in tokens. Consumed by screenForInjection's windowing. */
  readonly contextWindow: number;
  /** Largest completion the model will produce, used to clamp maxTokens. */
  readonly maxOutputTokens: number;
  /** Micro-USD per million prompt tokens. */
  readonly costPerMTokInMicros: number;
  /** Micro-USD per million completion tokens. */
  readonly costPerMTokOutMicros: number;
  /**
   * False means the price below is a doc 38 section 10 design target, not a
   * figure read off the provider's live pricing page. It is honest to say so:
   * these numbers only ever land in `ai_usage_events.cost_micros` and in the
   * budget estimate, never in a routing, approval or points decision, so an
   * imprecise one distorts a cost dashboard and nothing else. Reconcile before
   * launch (doc 38 section 10 lists the meter as the [SCALE] billing source,
   * which is when precision starts to matter).
   */
  readonly pricingVerified: boolean;
}

/**
 * Every model this platform is allowed to call. An id absent from this table
 * cannot be requested: `completeJson` takes `LlmModelId`, not `string`, so an
 * unpriceable model is a type error rather than an unmetered call.
 *
 * Availability measured against the live Groq key on 2026-07-26 (spec
 * 2026-07-26-ocr-rag-extraction-design.md section 1). Prices are micro-USD per
 * million tokens; see `pricingVerified`.
 */
export const LLM_MODELS = {
  "llama-3.3-70b-versatile": {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    costPerMTokInMicros: 590_000,
    costPerMTokOutMicros: 790_000,
    pricingVerified: false,
  },
  "llama-3.1-8b-instant": {
    id: "llama-3.1-8b-instant",
    provider: "groq",
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    costPerMTokInMicros: 50_000,
    costPerMTokOutMicros: 80_000,
    pricingVerified: false,
  },
  "openai/gpt-oss-120b": {
    id: "openai/gpt-oss-120b",
    provider: "groq",
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    costPerMTokInMicros: 150_000,
    costPerMTokOutMicros: 750_000,
    pricingVerified: false,
  },
  "qwen/qwen3.6-27b": {
    id: "qwen/qwen3.6-27b",
    provider: "groq",
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    // Unknown at the time of writing. Priced at the most expensive comparable
    // sibling on purpose: a meter that OVER-states spend trips a budget cap
    // early, which is a cheap and reversible failure. One that under-states it
    // lets a runaway loop spend real money under a cap that reads as healthy.
    costPerMTokInMicros: 590_000,
    costPerMTokOutMicros: 790_000,
    pricingVerified: false,
  },
  "meta-llama/llama-prompt-guard-2-86m": {
    id: "meta-llama/llama-prompt-guard-2-86m",
    provider: "groq",
    // 86M-parameter classifier with a small window. This is load-bearing:
    // screenForInjection must window long OCR text rather than truncate it,
    // or an injected line below the cut is simply never screened.
    contextWindow: 512,
    maxOutputTokens: 64,
    costPerMTokInMicros: 30_000,
    costPerMTokOutMicros: 30_000,
    pricingVerified: false,
  },
} as const satisfies Record<string, LlmModelEntry>;

export type LlmModelId = keyof typeof LLM_MODELS;

/**
 * Doc 38 section 1: features address a TASK, never a model name. The receipt
 * pipeline asks for `parse_assist` and gets whatever this table says today.
 */
export type LlmTask = "parse_assist" | "assistant" | "analytics" | "injection_screen";

/**
 * Task to model.
 *
 * Note a deliberate divergence from doc 38's table, which pins `parse_assist`
 * to `llama-3.1-8b-instant`. The extraction spec (section 7, "Env") supersedes
 * it: `llama-3.3-70b-versatile` is the measured default and 8b-instant is "the
 * cheap path if extraction quality holds". Parse-assist reads adversarial,
 * OCR-mangled text where a weaker model produces more discarded candidates,
 * and a discarded candidate costs a human review, which is far more expensive
 * than the token delta. Revisit with data from the review queue, at which
 * point the change is one line here.
 */
export const TASK_MODELS: Readonly<Record<LlmTask, LlmModelId>> = {
  parse_assist: "llama-3.3-70b-versatile",
  assistant: "llama-3.3-70b-versatile",
  analytics: "llama-3.3-70b-versatile",
  injection_screen: "meta-llama/llama-prompt-guard-2-86m",
};

export function isLlmModelId(value: string): value is LlmModelId {
  return Object.prototype.hasOwnProperty.call(LLM_MODELS, value);
}

export function getLlmModel(id: LlmModelId): LlmModelEntry {
  return LLM_MODELS[id];
}

/**
 * `ai_usage_events.cost_micros` for one call.
 *
 * Rounded, never negative and never fractional: the column is
 * `bigint ... check (cost_micros >= 0)` (migration 0017), so a float or a
 * negative here is a failed insert at the far end of the pipeline, long after
 * the LLM call it describes has been forgotten.
 */
export function computeCostMicros(
  id: LlmModelId,
  promptTokens: number,
  completionTokens: number,
): number {
  const model = LLM_MODELS[id];
  const inTokens = Math.max(0, promptTokens);
  const outTokens = Math.max(0, completionTokens);
  const micros =
    (inTokens * model.costPerMTokInMicros) / 1_000_000 +
    (outTokens * model.costPerMTokOutMicros) / 1_000_000;
  return Math.max(0, Math.round(micros));
}

/**
 * Rough token count from a character count. Four characters per token is the
 * usual English approximation and it is only ever used for the pre-call budget
 * estimate, never for the meter: the meter uses the provider's reported
 * `usage`, which is the billed number.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

/**
 * Worst-case cost of a call before making it, for the doc 38 section 10 budget
 * check. Assumes the completion runs to `maxTokens`, because a budget that
 * assumes the cheap case is not a cap.
 */
export function estimateCostMicros(
  id: LlmModelId,
  promptChars: number,
  maxTokens: number,
): number {
  return computeCostMicros(id, estimateTokens(promptChars), Math.max(0, maxTokens));
}
