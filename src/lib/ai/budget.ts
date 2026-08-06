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
//
// -----------------------------------------------------------------------------
// THE "NO MATCHED BUSINESS" BUCKET (review finding I2)
// -----------------------------------------------------------------------------
// A receipt with no matched business is NOT exempt from the cap. The first
// version of this module treated `businessId === null` as "nothing to scope
// a budget against" and returned `allowed: true` unconditionally - but null
// is not only doc 36 Stage 5's rare "no tenant matched" outcome, it is also
// what `receipts/server/submit.ts` writes whenever a consumer simply OMITS
// `business_id` on submit (that field is `z.string().uuid().optional()`).
// That made the cap trivially bypassable by client input, not merely by a
// pipeline fallback - exactly the hole this task exists to close.
//
// So every call with no business id is pooled into ONE shared bucket,
// `NO_BUSINESS_BUCKET` below, capped by the PLATFORM-scope `ai.budget` row
// (never a business override, because no real business id can ever equal
// the sentinel). This is doc 38's own key shape, not a bespoke mechanism:
// the doc's key is `{business_id}`-scoped, and a fixed sentinel is a legal
// value for that slot. It costs no new code path - `checkAiBudget` and
// `recordAiSpend` both resolve a "scope key" first and are otherwise
// unchanged for a real business id.
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

/**
 * The `ai.budget` setting, uncached. Three independent ways this returns
 * `DEFAULT_AI_BUDGET` instead of the configured row, and review finding I1
 * is that the first version of this module only had a TEST for the first
 * of them:
 *   1. no service-role key configured at all;
 *   2. the query itself comes back with `error !== null` (a live Postgres
 *      fault, not an absent credential);
 *   3. the query THROWS (a network fault before any response, the outer
 *      try/catch's job).
 * All three must degrade to the documented default, never to "no cap" - see
 * the module header. `loadAiBudgetSettingCached` below is what callers
 * actually use; this is kept as its own function so each of the three
 * branches is independently testable without fighting the cache.
 */
async function loadAiBudgetSetting(scopeKey: string): Promise<AiBudgetSetting> {
  try {
    const supabase = createServiceRoleClient();
    if (supabase === null) {
      console.warn(`${LOG_PREFIX} SUPABASE_SERVICE_ROLE_KEY is not configured; using the default AI budget`);
      return DEFAULT_AI_BUDGET;
    }

    // `business_id` is a uuid column. The sentinel scope key
    // (`NO_BUSINESS_BUCKET`) is deliberately NOT a uuid, so it must never
    // reach a `business_id.eq.<scopeKey>` filter - PostgREST would try to
    // cast it and every unmatched-business call would error on 22P02
    // (invalid uuid syntax) instead of cleanly resolving the platform row.
    const query = supabase
      .from("settings")
      .select("scope, business_id, key, value")
      .eq("key", AI_BUDGET_SETTING_KEY);
    const { data, error } =
      scopeKey === NO_BUSINESS_BUCKET
        ? await query.is("business_id", null)
        : await query.or(`business_id.is.null,business_id.eq.${scopeKey}`);

    if (error !== null) {
      console.error(`${LOG_PREFIX} settings read failed; using the default AI budget`, error);
      return DEFAULT_AI_BUDGET;
    }

    return resolveAiBudgetSetting((data ?? []) as AiBudgetSettingsRow[], scopeKey);
  } catch (unexpected) {
    console.error(`${LOG_PREFIX} settings read threw; using the default AI budget`, unexpected);
    return DEFAULT_AI_BUDGET;
  }
}

// ---------------------------------------------------------------------------
// The settings cache (30s, same TTL as src/lib/flags.ts's kill-switch cache)
// ---------------------------------------------------------------------------
//
// Review finding #3: the SPEND COUNTER (`checkAiBudget`'s Redis read) must
// stay live on every call - it is money-adjacent and caching it would let a
// call slip through on a stale "not yet over cap" read. The SETTING is a
// different kind of data: a slow-moving cap an operator tunes, structurally
// identical to a `feature_flags` row, and `screenForInjection` alone can
// call `checkAiBudget` up to six times for one receipt (one per overlap
// window) plus once more for `extract` - up to seven settings reads for a
// single scan with no cap change between them. Caching the SETTING (never
// the spend) closes that asymmetry the same way `flags.ts` already does for
// `is_enabled`, and for the identical reason: it is tolerant of a few
// seconds' staleness and the alternative is a database round trip on every
// gated call.
const SETTING_CACHE_TTL_MS = 30_000;

interface SettingCacheEntry {
  readonly setting: AiBudgetSetting;
  readonly expiresAt: number;
}

const settingCache = new Map<string, SettingCacheEntry>();

async function loadAiBudgetSettingCached(scopeKey: string): Promise<AiBudgetSetting> {
  const now = Date.now();
  const cached = settingCache.get(scopeKey);
  if (cached !== undefined && cached.expiresAt > now) return cached.setting;

  const setting = await loadAiBudgetSetting(scopeKey);
  settingCache.set(scopeKey, { setting, expiresAt: now + SETTING_CACHE_TTL_MS });
  return setting;
}

/** Test-only: clears the setting cache between test cases. Production code
 * has no reason to call this. */
export function __resetAiBudgetSettingCacheForTests(): void {
  settingCache.clear();
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

/**
 * The scope key for a call with NO matched business - review finding I2.
 * Deliberately NOT a valid uuid (`business_id`'s column type), so it can
 * never collide with a real tenant and a settings query scoped to it must
 * skip the uuid-comparing filter (see `loadAiBudgetSetting`). Every such
 * call is pooled into this ONE shared daily counter, capped by the
 * platform-scope `ai.budget` row - see the module header for why this is
 * not exemption, it is a fallback bucket.
 */
const NO_BUSINESS_BUCKET = "unmatched";

/**
 * Doc 38 section 1's key shape, verbatim: `{env}:ai:budget:{business_id}:
 * {yyyymmdd}`. `redisKey` supplies the `{env}` prefix. `scopeKey` is either
 * a real business id or `NO_BUSINESS_BUCKET`.
 *
 * Review finding #5: `{yyyymmdd}` in the doc has no separators, but
 * `manilaBudgetDay` returns `YYYY-MM-DD` (the useful, readable shape for a
 * function whose day arithmetic is worth getting right on its own, and
 * whose own doc and tests are written against that format). This function
 * is the one place those two facts have to reconcile, so the dashes are
 * stripped HERE, at the Redis key boundary, rather than either changing
 * `manilaBudgetDay`'s public shape or leaving the two silently diverged.
 * Doc 38 section 1 describes an hourly Postgres reconciliation job that
 * does not exist yet; when it does, it (and any ops runbook grepping the
 * documented key shape) needs to find `20260806`, not `2026-08-06`.
 */
function budgetRedisKey(scopeKey: string, day: string): string {
  return redisKey("ai", "budget", scopeKey, day.replaceAll("-", ""));
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

/** `businessId` -> the key every Redis/settings read in this module scopes
 * by: the real id, or `NO_BUSINESS_BUCKET` (review finding I2 - null must
 * still be capped, pooled, never exempt). */
function scopeKeyOf(businessId: string | null): string {
  return businessId ?? NO_BUSINESS_BUCKET;
}

/**
 * Doc 38 section 1 step 2, pre-call: would this call's worst-case cost push
 * today's spend for `businessId` (or the shared unmatched-business bucket,
 * see `NO_BUSINESS_BUCKET`) past the configured cap?
 */
export async function checkAiBudget(input: {
  readonly businessId: string | null;
  readonly estimatedCostMicros: number;
  readonly now: Date;
}): Promise<AiBudgetCheck> {
  const scopeKey = scopeKeyOf(input.businessId);
  const setting = await loadAiBudgetSettingCached(scopeKey);
  const key = budgetRedisKey(scopeKey, manilaBudgetDay(input.now));

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
 * against today's counter for `businessId` (or the shared unmatched-business
 * bucket), after the call completed.
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
  if (input.costMicros <= 0) return;

  const key = budgetRedisKey(scopeKeyOf(input.businessId), manilaBudgetDay(input.now));
  try {
    await incrby(key, input.costMicros);
    await expireNx(key, BUDGET_KEY_TTL_SECONDS);
  } catch (error) {
    console.error(`${LOG_PREFIX} could not record spend for ${key}; the counter may under-count`, error);
  }
}
