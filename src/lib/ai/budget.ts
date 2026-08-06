import "server-only";

import { z } from "zod";

import { expireNx, get as redisGet, incrby, redisKey } from "@/lib/redis";
import { createServiceRoleClient } from "@/lib/supabase/service";

// ===========================================================================
// Doc 38 section 1's budget check and section 10's cap: "Enforced pre-call
// from Redis counters (`{env}:ai:budget:{business_id}:{yyyymmdd}` ...),
// reconciled hourly against ai_usage_events (Redis is disposable, Postgres is
// truth - D4)." Section 10 also carries the setting shape this module reads
// (`settings` scope='platform'/'business', key='ai.budget') and the default
// values below are copied from its example verbatim.
//
// This module has exactly two callers, both from `src/lib/ai/llm.ts#chat`,
// the gateway's single choke point: `checkAiBudget` before the provider is
// ever contacted, `recordAiSpend` after a call's ACTUAL metered cost is
// known. Nothing else should import this file - the same reason nothing
// outside `src/lib/ai/llm.ts` imports the Groq wire format.
//
// -----------------------------------------------------------------------------
// TWO FAILURE MODES, TWO DIRECTIONS - AND THEY ARE OPPOSITE ON PURPOSE
// -----------------------------------------------------------------------------
// This module fails in DIFFERENT directions depending on WHAT is uncertain,
// and the asymmetry is deliberate, not an oversight - contrast
// `src/lib/flags.ts`, whose header argues for exactly ONE universal
// direction and explains why a kill switch does not get to have two:
//
//   * The `settings` READ fails (no service-role key, a query error, a
//     malformed `ai.budget` row). The documented DEFAULT cap
//     (`DEFAULT_AI_BUDGET`, copied from doc 38 section 10's own example) is
//     used instead of "no cap" - a budget check that answers "unreadable, so
//     unlimited" is not a budget check. This mirrors
//     `receipts/server/settings.ts`'s own rule: a bad or missing tuning row
//     degrades to the documented default, never to "off".
//   * The REDIS READ of the spend counter fails (the dependency is down).
//     Doc 38 section 10, verbatim: "losing Redis fails open for at most one
//     reconciliation cycle (bounded overspend, never data loss - D4)." This
//     is the OPPOSITE of `flags.ts`'s "fails closed on any uncertainty",
//     and correctly so: `flags.ts` guards an OPERATOR'S control being
//     unreachable, where "assume they would have said no" is the only safe
//     reading. This guards a SPEND COUNTER being unreachable, where Redis is
//     explicitly disposable (D4), Postgres reconciles the truth hourly
//     regardless of what this counter says, and OCR-adjacent scanning must
//     not be starved by an infrastructure blip on a system this codebase
//     already treats as best-effort everywhere else (`src/lib/redis.ts`'s
//     own velocity counters degrade the same way). Bounded overspend during
//     an outage is the accepted cost; a receipt that cannot be scanned
//     because a budget counter timed out is not.
//
// -----------------------------------------------------------------------------
// WHAT THIS MODULE DOES NOT DO
// -----------------------------------------------------------------------------
// It does not enforce `consumer_daily_cost_micros` (doc 38 section 10's "belt
// on top of the 100/day rate limit" for the not-yet-built consumer
// assistant). The receipt pipeline - the one live caller of the gateway -
// has no per-request consumer-scoped LLM budget concept today; it has a
// business. The value is still read and carried on `AiBudgetSetting` so a
// future assistant caller does not need a second settings reader, but
// nothing enforces it yet. Undercutting scope here on purpose: inventing
// enforcement for a caller that does not exist would be guessing at a
// contract nobody has designed.
//
// It also does not send the "soft warn at 80%" notification doc 38 section
// 10 describes (`kind: ai_budget_warning` via the notification service).
// That is a real gap, named rather than silently dropped: the notification
// service integration is out of this task's scope (feature-flags, kill
// switch, budget CAPS), and a warning that never fires is strictly less
// dangerous than a cap that never enforces.
// ===========================================================================

const LOG_PREFIX = "[ai/budget]";

/** `settings.key` this module reads, doc 38 section 10 verbatim. */
const AI_BUDGET_SETTING_KEY = "ai.budget";

/** Doc 38 section 10's own example values, copied verbatim as the fallback
 * when no row is configured or the configured row is malformed. */
export const DEFAULT_AI_BUDGET: AiBudgetSetting = {
  businessDailyCostMicros: 500_000,
  consumerDailyCostMicros: 20_000,
  warnThreshold: 0.8,
};

export interface AiBudgetSetting {
  readonly businessDailyCostMicros: number;
  readonly consumerDailyCostMicros: number;
  readonly warnThreshold: number;
}

const aiBudgetRowSchema = z.object({
  business_daily_cost_micros: z.number().int().positive(),
  consumer_daily_cost_micros: z.number().int().positive().optional(),
  warn_threshold: z.number().min(0).max(1).optional(),
});

/** A `settings` row as the service-role read returns it - same shape
 * `receipts/server/settings.ts#SettingsRow` declares, redeclared rather than
 * imported so this module stays independent of the receipts feature. */
export interface AiBudgetSettingsRow {
  readonly scope: string;
  readonly business_id: string | null;
  readonly key: string;
  readonly value: unknown;
}

/**
 * Resolve the rows this module's query can return into one typed budget,
 * business scope overriding platform scope - the identical precedence
 * `receipts/server/settings.ts#readValue` uses, restated here rather than
 * imported so the two settings readers stay independently testable and
 * neither can change the other's precedence by accident.
 *
 * Pure: no IO, so the precedence and validation rules are unit-testable
 * without a database.
 */
export function resolveAiBudgetSetting(
  rows: readonly AiBudgetSettingsRow[],
  businessId: string | null,
): AiBudgetSetting {
  let businessValue: unknown;
  let platformValue: unknown;

  for (const row of rows) {
    if (row.key !== AI_BUDGET_SETTING_KEY) continue;
    if (row.scope === "platform" && row.business_id === null) {
      platformValue = row.value;
    } else if (row.scope === "business" && businessId !== null && row.business_id === businessId) {
      businessValue = row.value;
    }
  }

  for (const [scope, candidate] of [
    ["business", businessValue],
    ["platform", platformValue],
  ] as const) {
    if (candidate === undefined) continue;
    const parsed = aiBudgetRowSchema.safeParse(candidate);
    if (parsed.success) {
      return {
        businessDailyCostMicros: parsed.data.business_daily_cost_micros,
        consumerDailyCostMicros:
          parsed.data.consumer_daily_cost_micros ?? DEFAULT_AI_BUDGET.consumerDailyCostMicros,
        warnThreshold: parsed.data.warn_threshold ?? DEFAULT_AI_BUDGET.warnThreshold,
      };
    }
    console.warn(
      `${LOG_PREFIX} ignoring a malformed ${scope}-scope ai.budget row`,
      parsed.error.issues.map((issue) => issue.message),
    );
  }

  return DEFAULT_AI_BUDGET;
}

async function loadAiBudgetSetting(businessId: string): Promise<AiBudgetSetting> {
  try {
    const supabase = createServiceRoleClient();
    if (supabase === null) {
      console.warn(`${LOG_PREFIX} SUPABASE_SERVICE_ROLE_KEY is not configured; using the default AI budget`);
      return DEFAULT_AI_BUDGET;
    }

    const { data, error } = await supabase
      .from("settings")
      .select("scope, business_id, key, value")
      .eq("key", AI_BUDGET_SETTING_KEY)
      .or(`business_id.is.null,business_id.eq.${businessId}`);

    if (error !== null) {
      console.error(`${LOG_PREFIX} settings read failed; using the default AI budget`, error);
      return DEFAULT_AI_BUDGET;
    }

    return resolveAiBudgetSetting((data ?? []) as AiBudgetSettingsRow[], businessId);
  } catch (unexpected) {
    console.error(`${LOG_PREFIX} settings read threw; using the default AI budget`, unexpected);
    return DEFAULT_AI_BUDGET;
  }
}

// ---------------------------------------------------------------------------
// The Manila day bucket and the Redis key
// ---------------------------------------------------------------------------

/** Doc 40's timezone canon, restated here (rather than imported from
 * `receipts/server/process.ts`, which does not export its own copy) so this
 * module's day bucket matches every other daily-window key in the codebase. */
const BUDGET_TIMEZONE = "Asia/Manila";

/** The Asia/Manila calendar day of an instant, as `YYYY-MM-DD`. */
export function manilaBudgetDay(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUDGET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Doc 38 section 1's key shape, verbatim: `{env}:ai:budget:{business_id}:
 * {yyyymmdd}`. `redisKey` supplies the `{env}` prefix. */
function budgetRedisKey(businessId: string, day: string): string {
  return redisKey("ai", "budget", businessId, day);
}

/** A little over a day: the key only ever needs to answer for the CURRENT
 * Manila day, and `expireNx` (set only on the first write) means a crash
 * between the increment and the expire self-heals on the next call rather
 * than leaving an immortal counter - the identical pattern the receipt
 * pipeline's velocity counters use. */
const BUDGET_KEY_TTL_SECONDS = 26 * 60 * 60;

// ---------------------------------------------------------------------------
// The two operations
// ---------------------------------------------------------------------------

export interface AiBudgetCheck {
  readonly allowed: boolean;
  readonly capMicros: number;
  readonly spentMicros: number;
}

/**
 * Doc 38 section 1 step 2, pre-call: would this call's worst-case cost push
 * today's spend for `businessId` past the configured cap?
 *
 * `businessId === null` (a receipt with no matched business) is ALLOWED
 * unconditionally: doc 38's cap is a per-BUSINESS daily cost, and there is no
 * tenant to charge a spend against or to protect from one. This is the same
 * shape the existing (unused until now) `LlmCallOptions.budgetMicros`
 * contract already had - "Omitted means unbudgeted" - applied to the one
 * case this module cannot scope at all.
 */
export async function checkAiBudget(input: {
  readonly businessId: string | null;
  readonly estimatedCostMicros: number;
  readonly now: Date;
}): Promise<AiBudgetCheck> {
  if (input.businessId === null) {
    return { allowed: true, capMicros: Number.POSITIVE_INFINITY, spentMicros: 0 };
  }

  const setting = await loadAiBudgetSetting(input.businessId);
  const key = budgetRedisKey(input.businessId, manilaBudgetDay(input.now));

  let spentMicros: number;
  try {
    const raw = await redisGet(key);
    const parsed = raw === null ? 0 : Number(raw);
    spentMicros = Number.isFinite(parsed) ? parsed : 0;
  } catch (error) {
    // Doc 38 section 10: "losing Redis fails open for at most one
    // reconciliation cycle (bounded overspend, never data loss - D4)". See
    // the module header for why this is the opposite direction from
    // src/lib/flags.ts's kill switch.
    console.warn(`${LOG_PREFIX} could not read the spend counter ${key}; failing open`, error);
    return { allowed: true, capMicros: setting.businessDailyCostMicros, spentMicros: 0 };
  }

  const capMicros = setting.businessDailyCostMicros;
  return {
    allowed: spentMicros + input.estimatedCostMicros <= capMicros,
    capMicros,
    spentMicros,
  };
}

/**
 * Doc 38 section 1 step 6 counterpart: record a call's ACTUAL metered cost
 * against today's counter for `businessId`, after the call completed.
 *
 * Never throws - a metering failure here must cost the counter's accuracy,
 * never the answer the caller already paid Groq for (same posture
 * `llm.ts#reportUsage` takes for the `ai_usage_events` write).
 */
export async function recordAiSpend(input: {
  readonly businessId: string | null;
  readonly costMicros: number;
  readonly now: Date;
}): Promise<void> {
  if (input.businessId === null || input.costMicros <= 0) return;

  const key = budgetRedisKey(input.businessId, manilaBudgetDay(input.now));
  try {
    await incrby(key, input.costMicros);
    await expireNx(key, BUDGET_KEY_TTL_SECONDS);
  } catch (error) {
    console.error(`${LOG_PREFIX} could not record spend for ${key}; the counter may under-count`, error);
  }
}
