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
  checkAiBudget,
  manilaBudgetDay,
  recordAiSpend,
  resolveAiBudgetSetting,
} from "./budget";
import type { AiBudgetSettingsRow } from "./budget";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";

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

describe("checkAiBudget", () => {
  it("allows unconditionally when businessId is null, and touches neither Redis nor settings", async () => {
    const result = await checkAiBudget({
      businessId: null,
      estimatedCostMicros: 999_999_999,
      now: new Date("2026-08-06T00:00:00.000Z"),
    });

    expect(result.allowed).toBe(true);
    expect(redisGet).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    // Named mutant: check the cap even when businessId is null (e.g. scope
    // the redis key by a placeholder like "none"). Killed by the two
    // not-toHaveBeenCalled assertions - an unscoped receipt must never
    // trigger a settings or Redis round trip.
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

  it("uses the default cap when the settings read fails (never 'no cap')", async () => {
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

  it("does nothing when businessId is null (no tenant to charge)", async () => {
    await recordAiSpend({ businessId: null, costMicros: 500, now: new Date() });

    expect(incrby).not.toHaveBeenCalled();
    expect(expireNx).not.toHaveBeenCalled();
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
