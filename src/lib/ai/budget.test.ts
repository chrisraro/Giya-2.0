// @vitest-environment node
//
// Server-only module (service-role Supabase reads, Redis reads/writes); no
// DOM anywhere in it, so it runs under plain Node like the other server
// modules in this codebase.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const createServiceRoleClient = vi.fn();
vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

const redisGet = vi.fn();
const incrby = vi.fn();
const expireNx = vi.fn();
vi.mock("@/lib/redis", () => ({
  get: (key: string) => redisGet(key),
  incrby: (key: string, amount: number) => incrby(key, amount),
  expireNx: (key: string, seconds: number) => expireNx(key, seconds),
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
}));

import {
  DEFAULT_AI_BUDGET,
  __resetAiBudgetSettingCacheForTests,
  checkAiBudget,
  manilaBudgetDay,
  recordAiSpend,
  resolveAiBudgetSetting,
} from "./budget";
import type { AiBudgetSettingsRow } from "./budget";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
/** Mirrors budget.ts's own private `NO_BUSINESS_BUCKET` sentinel. Not
 * imported (it is intentionally unexported - see the module's I2 note) so
 * this constant is redeclared, the same way `redisKey`'s `test:` prefix is
 * hardcoded rather than imported. */
const NO_BUSINESS_BUCKET = "unmatched";

function platformRow(value: unknown): AiBudgetSettingsRow {
  return { scope: "platform", business_id: null, key: "ai.budget", value };
}
function businessRow(value: unknown, businessId = BUSINESS_ID): AiBudgetSettingsRow {
  return { scope: "business", business_id: businessId, key: "ai.budget", value };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  redisGet.mockReset();
  incrby.mockReset();
  expireNx.mockReset();
  createServiceRoleClient.mockReset();
  // The settings cache is module-level state (review finding #3's fix) and
  // would otherwise leak a cached setting from one test into the next.
  __resetAiBudgetSettingCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// manilaBudgetDay
// ---------------------------------------------------------------------------

describe("manilaBudgetDay", () => {
  it("buckets by the Asia/Manila calendar day, not the UTC one", () => {
    // 2026-08-06T17:00:00Z is 2026-08-07 01:00 in Manila (UTC+8): the UTC
    // date and the Manila date disagree, which is exactly the case that
    // catches a mutant reading `instant.toISOString().slice(0, 10)` instead
    // of converting through the Asia/Manila timezone.
    expect(manilaBudgetDay(new Date("2026-08-06T17:00:00.000Z"))).toBe("2026-08-07");
    expect(manilaBudgetDay(new Date("2026-08-06T15:59:59.000Z"))).toBe("2026-08-06");
    // Named mutant: hardcode the timezone to "UTC" (or drop the `timeZone`
    // option entirely, which defaults to the host's). Killed by the first
    // assertion - a UTC read of that instant returns "2026-08-06", not
    // "2026-08-07".
  });
});

// ---------------------------------------------------------------------------
// resolveAiBudgetSetting
// ---------------------------------------------------------------------------

describe("resolveAiBudgetSetting", () => {
  it("returns the hardcoded default when no ai.budget row exists", () => {
    expect(resolveAiBudgetSetting([], BUSINESS_ID)).toEqual(DEFAULT_AI_BUDGET);
    // Named mutant: return `undefined`/`{}` instead of `DEFAULT_AI_BUDGET`
    // when both candidates are absent. Killed by the deep-equal above.
  });

  it("reads a valid platform-scope row", () => {
    const rows = [
      platformRow({ business_daily_cost_micros: 750_000, warn_threshold: 0.9 }),
    ];
    expect(resolveAiBudgetSetting(rows, BUSINESS_ID)).toEqual({
      businessDailyCostMicros: 750_000,
      consumerDailyCostMicros: DEFAULT_AI_BUDGET.consumerDailyCostMicros,
      warnThreshold: 0.9,
    });
    // Named mutant: ignore the platform row and always fall through to
    // DEFAULT_AI_BUDGET. Killed - 750_000 !== the default 500_000.
  });

  it("business-scope overrides platform-scope for the SAME business", () => {
    const rows = [
      platformRow({ business_daily_cost_micros: 500_000 }),
      businessRow({ business_daily_cost_micros: 2_000_000 }),
    ];
    expect(resolveAiBudgetSetting(rows, BUSINESS_ID).businessDailyCostMicros).toBe(2_000_000);
    // Named mutant: check platform BEFORE business (reverse the precedence
    // order). Killed - the platform row's 500_000 would win instead.
  });

  it("ignores a business row for a DIFFERENT business and falls back to platform", () => {
    const rows = [
      platformRow({ business_daily_cost_micros: 500_000 }),
      businessRow({ business_daily_cost_micros: 9_999_999 }, OTHER_BUSINESS_ID),
    ];
    expect(resolveAiBudgetSetting(rows, BUSINESS_ID).businessDailyCostMicros).toBe(500_000);
    // Named mutant: drop the `row.business_id === businessId` predicate and
    // accept ANY business-scope row. Killed - another tenant's 9_999_999
    // would leak into this business's cap.
  });

  it("falls through a malformed business row to a valid platform row", () => {
    const rows = [
      platformRow({ business_daily_cost_micros: 500_000 }),
      businessRow({ business_daily_cost_micros: -5 }), // fails .positive()
    ];
    expect(resolveAiBudgetSetting(rows, BUSINESS_ID).businessDailyCostMicros).toBe(500_000);
    // Named mutant: skip Zod validation and trust the business row's raw
    // value. Killed - a negative cap would either be returned directly or
    // make every budget check pass trivially (spent + estimate > -5 always).
  });

  it("falls back to the hardcoded default when every candidate is malformed", () => {
    const rows = [
      platformRow({ business_daily_cost_micros: "not-a-number" }),
      businessRow({ business_daily_cost_micros: 0 }), // fails .positive() (0 is not > 0)
    ];
    expect(resolveAiBudgetSetting(rows, BUSINESS_ID)).toEqual(DEFAULT_AI_BUDGET);
  });

  it("defaults consumerDailyCostMicros and warnThreshold when the row omits them", () => {
    const rows = [platformRow({ business_daily_cost_micros: 500_000 })];
    const resolved = resolveAiBudgetSetting(rows, BUSINESS_ID);
    expect(resolved.consumerDailyCostMicros).toBe(DEFAULT_AI_BUDGET.consumerDailyCostMicros);
    expect(resolved.warnThreshold).toBe(DEFAULT_AI_BUDGET.warnThreshold);
  });
});

// ---------------------------------------------------------------------------
// checkAiBudget
// ---------------------------------------------------------------------------

/** A settings client for a REAL business id: `loadAiBudgetSetting` issues
 * `.or("business_id.is.null,business_id.eq.<id>")` for this path. */
function settingsClient(row: unknown) {
  return {
    from: (table: string) => {
      expect(table).toBe("settings");
      return {
        select: () => ({
          eq: () => ({
            or: () => Promise.resolve({ data: row === undefined ? [] : [row], error: null }),
          }),
        }),
      };
    },
  };
}

/** A settings client for the `NO_BUSINESS_BUCKET` sentinel:
 * `loadAiBudgetSetting` must route this scope through `.is("business_id",
 * null)`, never through `.eq("business_id", "unmatched")` - that column is
 * `uuid`, and PostgREST would 22P02 on a non-uuid comparison value. */
function platformOnlySettingsClient(row: unknown) {
  return {
    from: (table: string) => {
      expect(table).toBe("settings");
      return {
        select: () => ({
          eq: () => ({
            is: (column: string, value: unknown) => {
              expect(column).toBe("business_id");
              expect(value).toBeNull();
              return Promise.resolve({ data: row === undefined ? [] : [row], error: null });
            },
            // Present so a mutant that keeps using `.or(...)` for the
            // sentinel path still gets a response shape it can await,
            // rather than crashing before the "wrong branch" assertion
            // below has a chance to fail honestly.
            or: () => Promise.resolve({ data: row === undefined ? [] : [row], error: null }),
          }),
        }),
      };
    },
  };
}

/** A settings client whose query resolves with a Postgres-shaped error
 * object (`{data: null, error: {...}}`) - review finding I1's first
 * uncovered branch: `error !== null` from a LIVE query, not from an absent
 * service-role key. */
function erroringSettingsClient(error: { message: string }) {
  return {
    from: (table: string) => {
      expect(table).toBe("settings");
      return {
        select: () => ({
          eq: () => ({
            or: () => Promise.resolve({ data: null, error }),
            is: () => Promise.resolve({ data: null, error }),
          }),
        }),
      };
    },
  };
}

/** A settings client whose query THROWS synchronously (or rejects) before
 * ever producing a `{data, error}` shape - review finding I1's second
 * uncovered branch, the outer try/catch. */
function throwingSettingsClient(error: Error) {
  return {
    from: () => {
      throw error;
    },
  };
}

describe("checkAiBudget", () => {
  it("pools a call with no matched business into the shared unmatched-business bucket, and CAPS it (review finding I2)", async () => {
    createServiceRoleClient.mockReturnValue(
      platformOnlySettingsClient({
        scope: "platform",
        business_id: null,
        key: "ai.budget",
        value: { business_daily_cost_micros: 1_000 },
      }),
    );
    redisGet.mockResolvedValue("999");

    const result = await checkAiBudget({
      businessId: null,
      estimatedCostMicros: 2,
      now: new Date("2026-08-06T00:00:00.000Z"),
    });

    expect(redisGet).toHaveBeenCalledWith(`test:ai:budget:${NO_BUSINESS_BUCKET}:2026-08-06`);
    expect(result).toEqual({ allowed: false, capMicros: 1_000, spentMicros: 999 });
    // Named mutant: keep the OLD `if (input.businessId === null) return
    // {allowed: true, capMicros: Infinity, ...}` short-circuit. Killed - a
    // consumer who simply omits `business_id` on submit
    // (receipts/server/submit.ts's field is optional) would spend against
    // no cap at all, which is the exact hole this task exists to close.
  });

  it("shares ONE counter across every unmatched-business call, not one per call", async () => {
    createServiceRoleClient.mockReturnValue(
      platformOnlySettingsClient({
        scope: "platform",
        business_id: null,
        key: "ai.budget",
        value: { business_daily_cost_micros: 1_000 },
      }),
    );
    redisGet.mockResolvedValue("0");

    await checkAiBudget({ businessId: null, estimatedCostMicros: 1, now: new Date("2026-08-06T00:00:00.000Z") });
    await checkAiBudget({ businessId: null, estimatedCostMicros: 1, now: new Date("2026-08-06T01:00:00.000Z") });

    const keysRead = redisGet.mock.calls.map((call) => call[0]);
    expect(new Set(keysRead).size).toBe(1);
    // Named mutant: scope the unmatched bucket by something call-specific
    // (e.g. a random id, or the estimate itself) instead of one fixed
    // sentinel. Killed - two different unmatched-business calls on the same
    // day would then read different keys, defeating the pooled cap entirely.
  });

  it("allows a call whose estimate keeps spend at or under the cap", async () => {
    createServiceRoleClient.mockReturnValue(
      settingsClient({ scope: "platform", business_id: null, key: "ai.budget", value: { business_daily_cost_micros: 1_000 } }),
    );
    redisGet.mockResolvedValue("400");

    const result = await checkAiBudget({
      businessId: BUSINESS_ID,
      estimatedCostMicros: 600,
      now: new Date("2026-08-06T00:00:00.000Z"),
    });

    expect(result).toEqual({ allowed: true, capMicros: 1_000, spentMicros: 400 });
    // Named mutant: use a strict `<` instead of `<=` for the cap comparison.
    // Killed - 400 + 600 === 1000 exactly, which must still be allowed.
  });

  it("refuses a call whose estimate would push spend over the cap", async () => {
    createServiceRoleClient.mockReturnValue(
      settingsClient({ scope: "platform", business_id: null, key: "ai.budget", value: { business_daily_cost_micros: 1_000 } }),
    );
    redisGet.mockResolvedValue("999");

    const result = await checkAiBudget({
      businessId: BUSINESS_ID,
      estimatedCostMicros: 2,
      now: new Date("2026-08-06T00:00:00.000Z"),
    });

    expect(result.allowed).toBe(false);
    // Named mutant: always return `allowed: true` (a no-op cap). Killed -
    // 999 + 2 = 1001 > 1000 must refuse.
  });

  it("treats an absent spend counter as zero spent so far", async () => {
    createServiceRoleClient.mockReturnValue(
      settingsClient({ scope: "platform", business_id: null, key: "ai.budget", value: { business_daily_cost_micros: 1_000 } }),
    );
    redisGet.mockResolvedValue(null);

    const result = await checkAiBudget({
      businessId: BUSINESS_ID,
      estimatedCostMicros: 500,
      now: new Date("2026-08-06T00:00:00.000Z"),
    });

    expect(result).toEqual({ allowed: true, capMicros: 1_000, spentMicros: 0 });
  });

  it("treats a malformed spend counter as zero spent so far", async () => {
    createServiceRoleClient.mockReturnValue(
      settingsClient({ scope: "platform", business_id: null, key: "ai.budget", value: { business_daily_cost_micros: 1_000 } }),
    );
    redisGet.mockResolvedValue("not-a-number");

    const result = await checkAiBudget({
      businessId: BUSINESS_ID,
      estimatedCostMicros: 500,
      now: new Date("2026-08-06T00:00:00.000Z"),
    });

    expect(result.spentMicros).toBe(0);
  });

  it("fails OPEN (allowed) when the Redis read throws - the opposite of the flag kill switch", async () => {
    createServiceRoleClient.mockReturnValue(
      settingsClient({ scope: "platform", business_id: null, key: "ai.budget", value: { business_daily_cost_micros: 1_000 } }),
    );
    redisGet.mockRejectedValue(new Error("ECONNRESET"));

    const result = await checkAiBudget({
      businessId: BUSINESS_ID,
      estimatedCostMicros: 999_999,
      now: new Date("2026-08-06T00:00:00.000Z"),
    });

    expect(result.allowed).toBe(true);
    // Named mutant: fail CLOSED on a Redis error (return `allowed: false`),
    // copying the flags.ts direction. Killed by this assertion - doc 38
    // section 10 explicitly documents the budget counter as fail-OPEN.
  });

  it("uses the default cap when there is no service-role client at all (never 'no cap')", async () => {
    createServiceRoleClient.mockReturnValue(null); // no service-role key configured
    redisGet.mockResolvedValue("0");

    const result = await checkAiBudget({
      businessId: BUSINESS_ID,
      estimatedCostMicros: DEFAULT_AI_BUDGET.businessDailyCostMicros + 1,
      now: new Date("2026-08-06T00:00:00.000Z"),
    });

    expect(result.capMicros).toBe(DEFAULT_AI_BUDGET.businessDailyCostMicros);
    expect(result.allowed).toBe(false);
    // Named mutant: treat an unreadable settings row as "no cap" (return
    // `allowed: true` / `capMicros: Infinity`) instead of the documented
    // default. Killed - an estimate one micro-USD over the DEFAULT cap must
    // still be refused, which only holds if the default is actually
    // enforced.
  });

  // Review finding I1: this branch (the settings QUERY resolving with a
  // Postgres-shaped error) and the next one (the query THROWING) were both
  // previously uncovered - only the `supabase === null` sub-branch above
  // had a test, and a mutant that flipped either of THESE two branches to
  // an effectively-infinite cap passed the full suite.
  it("uses the default cap when the settings query itself returns an error (I1, branch 2 of 3)", async () => {
    createServiceRoleClient.mockReturnValue(
      erroringSettingsClient({ message: "connection reset" }),
    );
    redisGet.mockResolvedValue("0");

    const result = await checkAiBudget({
      businessId: BUSINESS_ID,
      estimatedCostMicros: DEFAULT_AI_BUDGET.businessDailyCostMicros + 1,
      now: new Date("2026-08-06T00:00:00.000Z"),
    });

    expect(result.capMicros).toBe(DEFAULT_AI_BUDGET.businessDailyCostMicros);
    expect(result.allowed).toBe(false);
    // Named mutant: return `resolveAiBudgetSetting(data, businessId)`
    // unconditionally instead of checking `error !== null` first (would
    // call `resolveAiBudgetSetting([], ...)` on a null `data` array-cast,
    // landing on the default anyway by accident) OR, the mutant this test
    // actually targets: swallow the branch and read a stale/undefined cap
    // as Infinity. Killed by the exact-default-cap assertion combined with
    // the over-cap-estimate being refused.
  });

  it("uses the default cap when the settings query throws (I1, branch 3 of 3)", async () => {
    createServiceRoleClient.mockReturnValue(
      throwingSettingsClient(new Error("ECONNRESET")),
    );
    redisGet.mockResolvedValue("0");

    const result = await checkAiBudget({
      businessId: BUSINESS_ID,
      estimatedCostMicros: DEFAULT_AI_BUDGET.businessDailyCostMicros + 1,
      now: new Date("2026-08-06T00:00:00.000Z"),
    });

    expect(result.capMicros).toBe(DEFAULT_AI_BUDGET.businessDailyCostMicros);
    expect(result.allowed).toBe(false);
    // Named mutant: remove the outer try/catch in loadAiBudgetSetting.
    // Killed two ways at once - without the catch this test would reject
    // instead of resolving (checkAiBudget would throw, breaking the
    // gateway's fail-soft contract), and even if some OTHER catch caught it
    // and returned an infinite cap, the over-cap estimate would wrongly be
    // allowed.
  });

  it("caches the setting for 30s, so a burst of gated calls (screenForInjection's windows) costs one settings read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T00:00:00.000Z"));

    let settingsReads = 0;
    createServiceRoleClient.mockReturnValue({
      from: (table: string) => {
        expect(table).toBe("settings");
        return {
          select: () => ({
            eq: () => ({
              or: () => {
                settingsReads += 1;
                return Promise.resolve({
                  data: [
                    { scope: "platform", business_id: null, key: "ai.budget", value: { business_daily_cost_micros: 1_000 } },
                  ],
                  error: null,
                });
              },
            }),
          }),
        };
      },
    });
    redisGet.mockResolvedValue("0");

    await checkAiBudget({ businessId: BUSINESS_ID, estimatedCostMicros: 1, now: new Date() });
    vi.setSystemTime(new Date("2026-08-06T00:00:29.000Z")); // +29s, inside the TTL
    await checkAiBudget({ businessId: BUSINESS_ID, estimatedCostMicros: 1, now: new Date() });

    expect(settingsReads).toBe(1);
    // Named mutant: skip the setting cache entirely (call
    // loadAiBudgetSetting directly on every checkAiBudget). Killed -
    // `settingsReads` would be 2. This does NOT prove the cache expires
    // (a permanent cache also reads 1 here); that half is the Redis spend
    // read, which is asserted to run on EVERY call, unlike the setting.

    vi.useRealTimers();
  });

  it("still reads the spend counter fresh on every call, even while the setting is cached", async () => {
    createServiceRoleClient.mockReturnValue(
      settingsClient({ scope: "platform", business_id: null, key: "ai.budget", value: { business_daily_cost_micros: 1_000 } }),
    );
    redisGet.mockResolvedValue("0");

    await checkAiBudget({ businessId: BUSINESS_ID, estimatedCostMicros: 1, now: new Date("2026-08-06T00:00:00.000Z") });
    await checkAiBudget({ businessId: BUSINESS_ID, estimatedCostMicros: 1, now: new Date("2026-08-06T00:00:01.000Z") });

    expect(redisGet).toHaveBeenCalledTimes(2);
    // Named mutant: cache the WHOLE AiBudgetCheck result (including
    // spentMicros), not just the setting. Killed - `redisGet` would only
    // be called once, and this is the exact bug the module header calls
    // out as unacceptable: "the SPEND COUNTER... must stay live on every
    // call... caching it would let a call slip through on a stale
    // 'not yet over cap' read."
  });
});

// ---------------------------------------------------------------------------
// recordAiSpend
// ---------------------------------------------------------------------------

describe("recordAiSpend", () => {
  it("increments the business's counter for today's Manila day and sets a self-healing TTL", async () => {
    incrby.mockResolvedValue(873);
    expireNx.mockResolvedValue(true);

    await recordAiSpend({
      businessId: BUSINESS_ID,
      costMicros: 873,
      now: new Date("2026-08-06T04:00:00.000Z"), // 2026-08-06 12:00 Manila
    });

    expect(incrby).toHaveBeenCalledWith(`test:ai:budget:${BUSINESS_ID}:2026-08-06`, 873);
    expect(expireNx).toHaveBeenCalledWith(`test:ai:budget:${BUSINESS_ID}:2026-08-06`, expect.any(Number));
    // Named mutant: call `expireNx` unconditionally with `EXPIRE` semantics
    // instead of `expireNx` (would push the window out on every call rather
    // than only the first). Killed by asserting the specific function
    // (`expireNx`, mocked separately from a plain `expire`) was called.
  });

  it("records a null-business call against the shared unmatched-business bucket (review finding I2), not a no-op", async () => {
    incrby.mockResolvedValue(500);
    expireNx.mockResolvedValue(true);

    await recordAiSpend({
      businessId: null,
      costMicros: 500,
      now: new Date("2026-08-06T04:00:00.000Z"), // 2026-08-06 12:00 Manila
    });

    expect(incrby).toHaveBeenCalledWith(`test:ai:budget:${NO_BUSINESS_BUCKET}:2026-08-06`, 500);
    // Named mutant: keep the OLD `if (businessId === null) return` early
    // exit. Killed - spend on an unmatched-business call would then never
    // be recorded anywhere, so `checkAiBudget`'s pooled cap (see the test
    // above) would never actually fill up no matter how many such calls
    // were made.
  });

  it("does nothing when costMicros is zero or negative", async () => {
    await recordAiSpend({ businessId: BUSINESS_ID, costMicros: 0, now: new Date() });
    await recordAiSpend({ businessId: BUSINESS_ID, costMicros: -1, now: new Date() });

    expect(incrby).not.toHaveBeenCalled();
    // Named mutant: drop the `costMicros <= 0` guard. Killed - a zero-cost
    // call (e.g. a cached/free path) would otherwise still write a counter
    // entry.
  });

  it("never throws when Redis fails", async () => {
    incrby.mockRejectedValue(new Error("ECONNRESET"));

    await expect(
      recordAiSpend({ businessId: BUSINESS_ID, costMicros: 100, now: new Date() }),
    ).resolves.toBeUndefined();
    // Named mutant: remove the try/catch around the incrby/expireNx calls.
    // Killed - the promise would reject instead of resolving, which would
    // break llm.ts's fail-soft contract for its caller.
  });
});
