// @vitest-environment node
//
// ===========================================================================
// THE MERCHANT VERIFICATION QUEUE AND THE TWO DECISIONS IT LEADS TO.
//
// WHAT THIS SUITE IS FOR. `/admin/businesses` is the only surface on this
// platform that can set `businesses.status` to 'active', and 'active' is the
// predicate every consumer-facing read filters on. So these assertions are
// about two things and nothing else:
//
//   1. THE QUEUE ASKS THE RIGHT QUESTION. Pending businesses only, oldest
//      first, with the earning rule resolved - because that rule is the
//      precondition `activate_business` (migration 0033) enforces, and an admin
//      who presses approve without it gets a refusal with nothing on screen
//      explaining why.
//   2. A FAILED READ IS NOT AN EMPTY QUEUE. Every row on this list is a
//      merchant who cannot trade. "Nobody is waiting" is a claim a dropped
//      connection is not entitled to make.
// ===========================================================================

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import type { Database } from "@/lib/supabase/types";

import { listBusinessesAwaitingReview } from "./businesses";
import type { AdminBusinessDeps } from "./businesses";
import { activateBusiness, rejectBusinessVerification } from "./business-decisions";
import type { BusinessDecisionDeps } from "./business-decisions";

// ---------------------------------------------------------------------------
// Fake Supabase client, the same shape ./queue.test.ts uses
// ---------------------------------------------------------------------------

interface Op {
  table: string;
  columns: string;
  filters: Array<{ method: string; args: unknown[] }>;
}

interface Result {
  data: unknown;
  error: { message: string } | null;
}

type Responder = (op: Op) => Result;

class FakeQuery implements PromiseLike<Result> {
  readonly op: Op;

  constructor(
    table: string,
    private readonly respond: Responder,
    private readonly log: (op: Op) => void,
  ) {
    this.op = { table, columns: "*", filters: [] };
  }

  select(columns?: string): this {
    this.op.columns = columns ?? "*";
    return this;
  }
  private filter(method: string, ...args: unknown[]): this {
    this.op.filters.push({ method, args });
    return this;
  }
  eq(column: string, value: unknown): this {
    return this.filter("eq", column, value);
  }
  in(column: string, values: unknown[]): this {
    return this.filter("in", column, values);
  }
  is(column: string, value: unknown): this {
    return this.filter("is", column, value);
  }
  order(column: string, options?: unknown): this {
    return this.filter("order", column, options);
  }
  limit(count: number): this {
    return this.filter("limit", count);
  }

  then<T1 = Result, T2 = never>(
    onFulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve()
      .then(() => {
        this.log(this.op);
        return this.respond(this.op);
      })
      .then(onFulfilled, onRejected);
  }
}

interface Harness {
  deps: AdminBusinessDeps;
  ops: Op[];
  opsFor: (table: string) => Op[];
}

function createHarness(respond: Responder): Harness {
  const ops: Op[] = [];
  const client = {
    from: (table: string) => new FakeQuery(table, respond, (op) => ops.push(op)),
  };
  return {
    deps: { supabase: client as unknown as SupabaseClient<Database> },
    ops,
    opsFor: (table) => ops.filter((op) => op.table === table),
  };
}

function hasFilter(op: Op, method: string, column: string, value?: unknown): boolean {
  return op.filters.some(
    (f) => f.method === method && f.args[0] === column && (value === undefined || f.args[1] === value),
  );
}

const BIZ = "aaaaaaaa-1111-4111-8111-111111111111";
const OWNER = "bbbbbbbb-2222-4222-8222-222222222222";
const CITY = "cccccccc-3333-4333-8333-333333333333";
const TYPE = "dddddddd-4444-4444-8444-444444444444";
const ADMIN = "eeeeeeee-5555-4555-8555-555555555555";

function businessRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BIZ,
    name: "Kape Bagong Silang",
    slug: "kape-bagong-silang",
    email: "hello@kapebagong.ph",
    phone: null,
    city_id: CITY,
    business_type_id: TYPE,
    created_at: "2026-07-20T02:00:00.000Z",
    ...overrides,
  };
}

/** A responder that answers every table the queue reads, with sensible defaults. */
function respondAll(overrides: Partial<Record<string, Result>> = {}): Responder {
  const defaults: Record<string, Result> = {
    businesses: { data: [businessRow()], error: null },
    ref_cities: { data: [{ id: CITY, name: "Naga" }], error: null },
    ref_business_types: { data: [{ id: TYPE, name: "Cafe" }], error: null },
    business_staff: { data: [{ business_id: BIZ, user_id: OWNER }], error: null },
    profiles: { data: [{ id: OWNER, display_name: "Ramon Dela Cruz" }], error: null },
    business_verifications: {
      data: [
        {
          business_id: BIZ,
          notes: "Permits are with the city hall.",
          created_at: "2026-07-25T02:00:00.000Z",
        },
      ],
      error: null,
    },
    points_rules: {
      data: [
        {
          business_id: BIZ,
          rule_type: "amount_rate",
          rate_centavos_per_point: 10000,
          fixed_points: null,
          tiers: null,
        },
      ],
      error: null,
    },
    products: { data: [{ business_id: BIZ }], error: null },
  };
  return (op) => overrides[op.table] ?? defaults[op.table] ?? { data: [], error: null };
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

describe("listBusinessesAwaitingReview", () => {
  it("asks only for pending, undeleted businesses, oldest first", async () => {
    const h = createHarness(respondAll());
    await listBusinessesAwaitingReview(h.deps);

    const op = h.opsFor("businesses")[0];
    expect(op).toBeDefined();
    expect(hasFilter(op!, "eq", "status", "pending_verification") || hasFilter(op!, "in", "status")).toBe(true);
    expect(hasFilter(op!, "is", "deleted_at", null)).toBe(true);
    expect(
      op!.filters.some(
        (f) =>
          f.method === "order" &&
          f.args[0] === "created_at" &&
          (f.args[1] as { ascending?: boolean } | undefined)?.ascending === true,
      ),
    ).toBe(true);
  });

  it("assembles the facts an admin decides on", async () => {
    const h = createHarness(respondAll());
    const items = await listBusinessesAwaitingReview(h.deps);

    expect(items).toHaveLength(1);
    expect(items?.[0]).toMatchObject({
      businessId: BIZ,
      name: "Kape Bagong Silang",
      cityName: "Naga",
      businessTypeName: "Cafe",
      ownerName: "Ramon Dela Cruz",
      contactEmail: "hello@kapebagong.ph",
      submittedAt: "2026-07-25T02:00:00.000Z",
      applicantNote: "Permits are with the city hall.",
      earningRule: "1 point per ₱100.00 spent",
      hasMenu: true,
    });
  });

  it("CRITICAL: reports a missing earning rule as null, because the RPC will refuse it", async () => {
    const h = createHarness(respondAll({ points_rules: { data: [], error: null } }));
    const items = await listBusinessesAwaitingReview(h.deps);
    expect(items?.[0]?.earningRule).toBeNull();
  });

  it("CRITICAL: reports a half-filled earning rule as null too", async () => {
    // An amount_rate row with no rate passes every database constraint and
    // awards nothing. Showing it as a rule would tell the admin to approve a
    // business the activation RPC then refuses.
    const h = createHarness(
      respondAll({
        points_rules: {
          data: [
            {
              business_id: BIZ,
              rule_type: "amount_rate",
              rate_centavos_per_point: null,
              fixed_points: null,
              tiers: null,
            },
          ],
          error: null,
        },
      }),
    );
    const items = await listBusinessesAwaitingReview(h.deps);
    expect(items?.[0]?.earningRule).toBeNull();
  });

  it("CRITICAL: returns null when the queue read failed, never an empty list", async () => {
    const h = createHarness(respondAll({ businesses: { data: null, error: { message: "boom" } } }));
    expect(await listBusinessesAwaitingReview(h.deps)).toBeNull();
  });

  it("returns an empty list when there genuinely is nobody waiting", async () => {
    const h = createHarness(respondAll({ businesses: { data: [], error: null } }));
    expect(await listBusinessesAwaitingReview(h.deps)).toEqual([]);
  });

  it("still renders the row when a decoration read fails", async () => {
    // A city lookup that fell over must not hide a merchant who cannot trade.
    const h = createHarness(respondAll({ ref_cities: { data: null, error: { message: "boom" } } }));
    const items = await listBusinessesAwaitingReview(h.deps);
    expect(items).toHaveLength(1);
    expect(items?.[0]?.cityName).toBeNull();
  });

  it("refuses to guess with no service-role client", async () => {
    expect(await listBusinessesAwaitingReview(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The decisions
// ---------------------------------------------------------------------------

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function decisionHarness(error: { message: string } | null = null): {
  calls: RpcCall[];
  deps: BusinessDecisionDeps;
} {
  const calls: RpcCall[] = [];
  const supabase = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return Promise.resolve({ data: null, error });
    },
  };
  return { calls, deps: { supabase: supabase as unknown as SupabaseClient<Database> } };
}

const GOOD_REASON = "Mayor's permit checked against the city registry.";

describe("activateBusiness", () => {
  it("calls the RPC with the trimmed reason and the session-resolved actor", async () => {
    const h = decisionHarness();
    const outcome = await activateBusiness(
      { businessId: BIZ, actorId: ADMIN, reason: `  ${GOOD_REASON}  `, requestId: "req-1" },
      h.deps,
    );

    expect(outcome).toEqual({ ok: true });
    expect(h.calls[0]?.fn).toBe("activate_business");
    expect(h.calls[0]?.args).toEqual({
      p_business_id: BIZ,
      p_actor_id: ADMIN,
      p_reason: GOOD_REASON,
      p_request_id: "req-1",
    });
  });

  it("CRITICAL: refuses a blank reason before it reaches SQL", async () => {
    const h = decisionHarness();
    const outcome = await activateBusiness(
      { businessId: BIZ, actorId: ADMIN, reason: "   ", requestId: "req-1" },
      h.deps,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("REASON_REQUIRED");
    expect(h.calls).toHaveLength(0);
  });

  it("CRITICAL: explains the missing-earning-rule refusal in terms of what it costs a customer", async () => {
    const h = decisionHarness({ message: "ACTIVATION_NO_EARNING_RULE" });
    const outcome = await activateBusiness(
      { businessId: BIZ, actorId: ADMIN, reason: GOOD_REASON, requestId: "req-1" },
      h.deps,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("NO_EARNING_RULE");
    expect(outcome.message).toMatch(/award nothing/i);
  });

  it("maps every stable RPC message to its own code", async () => {
    const cases = [
      ["ACTIVATION_REASON_REQUIRED", "REASON_REQUIRED"],
      ["ACTIVATION_FORBIDDEN", "FORBIDDEN"],
      ["BUSINESS_NOT_FOUND", "NOT_FOUND"],
      ["ACTIVATION_INVALID_STATE", "INVALID_STATE"],
      ["something nobody registered", "WRITE_FAILED"],
    ] as const;

    for (const [message, code] of cases) {
      const h = decisionHarness({ message });
      const outcome = await activateBusiness(
        { businessId: BIZ, actorId: ADMIN, reason: GOOD_REASON, requestId: "req-1" },
        h.deps,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.code).toBe(code);
    }
  });

  it("refuses to act at all with no service-role client", async () => {
    const outcome = await activateBusiness(
      { businessId: BIZ, actorId: ADMIN, reason: GOOD_REASON, requestId: "req-1" },
      null,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("DEPENDENCY_UNAVAILABLE");
  });
});

describe("rejectBusinessVerification", () => {
  it("sends the reason the merchant will read", async () => {
    const h = decisionHarness();
    const outcome = await rejectBusinessVerification(
      {
        businessId: BIZ,
        actorId: ADMIN,
        reason: "The address on the permit does not match the listing.",
        requestId: "req-2",
      },
      h.deps,
    );

    expect(outcome).toEqual({ ok: true });
    expect(h.calls[0]?.fn).toBe("reject_business_verification");
    expect(h.calls[0]?.args.p_reason).toBe(
      "The address on the permit does not match the listing.",
    );
  });

  it("CRITICAL: refuses a blank reason, because the merchant would be sent back with nothing", async () => {
    const h = decisionHarness();
    const outcome = await rejectBusinessVerification(
      { businessId: BIZ, actorId: ADMIN, reason: "", requestId: "req-2" },
      h.deps,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("REASON_REQUIRED");
    expect(h.calls).toHaveLength(0);
  });

  it("maps its own stable RPC messages", async () => {
    const cases = [
      ["REJECTION_FORBIDDEN", "FORBIDDEN"],
      ["BUSINESS_NOT_FOUND", "NOT_FOUND"],
      ["REJECTION_INVALID_STATE", "INVALID_STATE"],
    ] as const;

    for (const [message, code] of cases) {
      const h = decisionHarness({ message });
      const outcome = await rejectBusinessVerification(
        { businessId: BIZ, actorId: ADMIN, reason: "Fix the permit.", requestId: "req-2" },
        h.deps,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.code).toBe(code);
    }
  });
});
