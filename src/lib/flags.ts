import "server-only";

import { createServiceRoleClient } from "@/lib/supabase/service";

// ===========================================================================
// `feature_flags` (migration 0062), read once from a single cached reader per
// doc 31 section 7: "implemented once in src/lib/flags.ts, used server +
// client". Doc 38 section 1 is the caller that matters today: the LLM
// gateway's kill switch, consulted before any model call and "cached 30s -
// a bad model day is a toggle, not a deploy".
//
// This module caches IN PROCESS MEMORY, not Redis (doc 38's literal words are
// "cached 30s in Redis"). That is a deliberate narrowing, not an oversight:
// `src/lib/redis.ts#sendCommand` throws on a failed request ("fail closed...
// a Redis outage must never be treated as key absent"), which is exactly
// backwards for a cache whose whole job is to survive a dependency being slow
// or unavailable without adding a NEW one of its own. A kill switch that
// cannot be READ because the thing that caches it is down is not a kill
// switch, it is a second outage stacked on the first. An in-process Map can
// only ever be stale, never a new failure mode, and it costs nothing extra to
// wire.
//
// -----------------------------------------------------------------------------
// THE FAIL-SAFE DIRECTION, ARGUED, NOT ASSUMED
// -----------------------------------------------------------------------------
// Every flag this module knows about today - `AI_PARSE_ASSIST_FLAG`,
// `AI_ASSISTANT_FLAG`, `AI_ANALYTICS_FLAG` - is a KILL SWITCH: a control whose
// entire purpose is "operator can turn this OFF without a deploy". For a kill
// switch, uncertainty about the operator's intent must resolve to the SAME
// state as "the operator turned it off", not to "the operator meant to leave
// it on". Two failure classes prove the same point from different angles:
//
//   * The row cannot be READ (no service-role key, a Postgres outage, a
//     malformed value). The gateway cannot tell "the operator wants this off"
//     apart from "the control itself is unreachable". Reading the second as
//     "on" means the ONE DAY this table cannot be reached is also the one day
//     nobody can turn AI spend off - the exact worst-day control the brief
//     names, gone precisely when it is needed. `ai_parse_assist` off routes a
//     receipt to the documented human-review fallback (doc 36 Stage 7's own
//     "the LLM is tier 3, and the deterministic tiers are a complete
//     strategy on their own"); that is a bounded, known-safe cost. Guessing
//     "on" risks unpriced, unbounded model spend against a control nobody can
//     currently reach to stop it.
//   * The row is simply ABSENT (a key this build does not know about yet, or
//     one deleted rather than turned off). There is no evidence anyone
//     enabled it, so "off" is the only reading that is not a guess.
//
// So EVERY key this reader is asked about fails to `false` on every read
// failure - not just the three named above. This is a stronger claim than
// "argue it per flag" strictly requires, and the reason a single universal
// direction is still correct: `feature_flags` (0062) exists FOR kill
// switches (see that migration's header - `rollout` is carried but nothing
// reads it yet), so there is no flag registered today whose safe direction
// runs the other way. The day a flag is added whose risk is asymmetric in
// the OTHER direction (e.g. a purely cosmetic UI experiment where "off"
// disables a feature users already rely on), the correct fix is a per-key
// override table here, not a silent exception - and that day has not come.
//
// -----------------------------------------------------------------------------
// WHAT THIS MODULE DOES NOT DO
// -----------------------------------------------------------------------------
// It reads `is_enabled` and nothing else. Doc 31 section 7's staged-rollout
// ladder (`rollout.percent`, `rollout.business_ids`, `rollout.plans`,
// `rollout.beta`) is written for a build with a client-side flag consumer to
// stage a rollout FOR - the consumer AI assistant, `offline_sync` - and none
// of that exists in this codebase yet (`/api/v1/ai/chat` is undesigned; see
// migration 0062's header). Reading a column nothing can act on would be
// dead code pretending to be a feature. `rollout` is persisted so the column
// exists without a second migration once a staged-rollout reader is needed;
// today it is a kill switch and nothing more.
// ===========================================================================

/** Doc 38 section 1's three AI kill-switch keys, as typed constants so a
 * caller cannot typo one into a key this table never seeds. */
export const AI_PARSE_ASSIST_FLAG = "ai_parse_assist" as const;
export const AI_ASSISTANT_FLAG = "ai_assistant" as const;
export const AI_ANALYTICS_FLAG = "ai_analytics" as const;

export type AiKillSwitchFlag =
  | typeof AI_PARSE_ASSIST_FLAG
  | typeof AI_ASSISTANT_FLAG
  | typeof AI_ANALYTICS_FLAG;

/** How long a read is trusted before the next caller pays for a fresh one.
 * Doc 38 section 1, verbatim: "cached 30s". */
const CACHE_TTL_MS = 30_000;

const LOG_PREFIX = "[flags]";

interface FlagCacheEntry {
  readonly enabled: boolean;
  readonly expiresAt: number;
}

/** Module-level: one process, one cache. Every entry independently expires
 * on its own 30s clock from when IT was last read, not a shared timer. */
const cache = new Map<string, FlagCacheEntry>();

/**
 * Read `is_enabled` straight from Postgres, no cache. Every failure path -
 * no service-role key, a query error, no row for this key, an unexpected
 * throw - resolves to `false`. See the module header for why that is the
 * one safe direction for every key this table registers.
 */
async function fetchIsEnabled(key: string): Promise<boolean> {
  let client;
  try {
    client = createServiceRoleClient();
  } catch (unexpected) {
    console.error(`${LOG_PREFIX} could not create the service-role client for "${key}"; reading as disabled`, unexpected);
    return false;
  }
  if (client === null) {
    console.warn(`${LOG_PREFIX} SUPABASE_SERVICE_ROLE_KEY is not configured; "${key}" reads as disabled`);
    return false;
  }

  try {
    const { data, error } = await client
      .from("feature_flags")
      .select("is_enabled")
      .eq("key", key)
      .maybeSingle<{ is_enabled: boolean }>();

    if (error !== null) {
      console.error(`${LOG_PREFIX} could not read flag "${key}"; reading as disabled`, error);
      return false;
    }
    if (data === null) {
      // Absent, not merely unreadable: no row has ever named this key.
      console.warn(`${LOG_PREFIX} flag "${key}" has no row; reading as disabled`);
      return false;
    }
    return data.is_enabled;
  } catch (unexpected) {
    console.error(`${LOG_PREFIX} read threw for flag "${key}"; reading as disabled`, unexpected);
    return false;
  }
}

/**
 * Whether `key` is on right now, per the 30s cache above.
 *
 * Never throws: every failure inside `fetchIsEnabled` is already caught and
 * turned into `false`, so a caller (the LLM gateway, chiefly) never needs a
 * try/catch of its own around this call.
 */
export async function isFeatureEnabled(key: string): Promise<boolean> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.enabled;
  }

  const enabled = await fetchIsEnabled(key);
  // A failed read is cached too, at the same TTL: re-hitting a down database
  // on every single call inside the 30s window would turn one outage into a
  // request storm, and the answer ("disabled") is the same either way.
  cache.set(key, { enabled, expiresAt: now + CACHE_TTL_MS });
  return enabled;
}

/**
 * Test-only: clears every cached entry. Production code has no reason to
 * ever call this - the cache existing for the process's whole lifetime past
 * its TTL is the point.
 */
export function __resetFeatureFlagCacheForTests(): void {
  cache.clear();
}
