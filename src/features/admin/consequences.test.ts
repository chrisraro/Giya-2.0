// @vitest-environment node
//
// Doc 37's consequences ladder, admin half.
//
// WHAT THIS SUITE IS FOR, in one sentence: every action refuses without a
// reason, and every action that lands writes exactly one `audit_logs` row
// carrying that reason with `actor_kind='admin'`. Those two facts are the whole
// security posture of this portal - doc 15 states the reason requirement twice
// as a control and 0022 makes it a database check constraint - so they are
// asserted for each action individually rather than once for a helper.
//
// The third thing under test is the failure path nobody looks at: when the
// audit row cannot be written, the state change is REVERTED. An admin action
// with no audit row behind it is the exact condition doc 15 forbids, so the
// code must not simply report the failure and leave the change standing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import type { Database } from "@/lib/supabase/types";

import {
  applyCooldown,
  clawbackReceipt,
  liftCooldown,
  suspendConsumer,
  unsuspendConsumer,
} from "./consequences";
import type { ConsequenceDeps } from "./consequences";

// ---------------------------------------------------------------------------
// A fake Supabase client, same family as receipts/review/queue.test.ts
// ---------------------------------------------------------------------------

interface Op {
  table: string;
  op: "select" | "insert" | "update";
  filters: Array<{ method: string; args: unknown[] }>;
  values?: Record<string, unknown>;
  single: boolean;
}

interface Result {
  data: unknown;
  error: { message: string } | null;
}

type Responder = (op: Op) => Result;

class FakeQuery implements PromiseLike<Result> {
  readonly record: Op;

  constructor(
    table: string,
    private readonly respond: Responder,
    private readonly log: (op: Op) => void,
  ) {
    this.record = { table, op: "select", filters: [], single: false };
  }

  select(): this {
    return this;
  }
  insert(values: Record<string, unknown>): this {
    this.record.op = "insert";
    this.record.values = values;
    return this;
  }
  update(values: Record<string, unknown>): this {
    this.record.op = "update";
    this.record.values = values;
    return this;
  }
  eq(column: string, value: unknown): this {
    this.record.filters.push({ method: "eq", args: [column, value] });
    return this;
  }
  maybeSingle(): this {
    this.record.single = true;
    return this;
  }

  then<T1 = Result, T2 = never>(
    onFulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve()
      .then(() => {
        this.log(this.record);
        const result = this.respond(this.record);
        if (!this.record.single || result.error !== null) return result;
        const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
        return { data, error: null };
      })
      .then(onFulfilled, onRejected);
  }
}

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

interface World {
  deps: ConsequenceDeps;
  ops: Op[];
  rpcs: RpcCall[];
  auditRows(): Array<Record<string, unknown>>;
  updatesTo(table: string): Op[];
}

const NOW = new Date("2026-07-26T12:00:00.000Z");
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const CONSUMER_ID = "22222222-2222-4222-8222-222222222222";
const RECEIPT_ID = "33333333-3333-4333-8333-333333333333";
const REASON = "matched a receipt submitted at another business";

interface WorldOptions {
  adminRole?: string | null;
  scanBlockedUntil?: string | null;
  isSuspended?: boolean;
  suspendedReason?: string | null;
  consumerMissing?: boolean;
  profileMissing?: boolean;
  auditError?: { message: string } | null;
  updateError?: { message: string } | null;
  revertError?: { message: string } | null;
  rpcError?: { message: string } | null;
  rpcResult?: unknown;
}

function createWorld(options: WorldOptions = {}): World {
  const ops: Op[] = [];
  const rpcs: RpcCall[] = [];
  let updateCount = 0;

  const respond: Responder = (op) => {
    if (op.table === "platform_admins") {
      const role = options.adminRole === undefined ? "admin" : options.adminRole;
      return { data: role === null ? null : { role, is_active: true }, error: null };
    }
    if (op.table === "consumers" && op.op === "select") {
      return options.consumerMissing === true
        ? { data: null, error: null }
        : {
            data: { id: CONSUMER_ID, scan_blocked_until: options.scanBlockedUntil ?? null },
            error: null,
          };
    }
    if (op.table === "profiles" && op.op === "select") {
      return options.profileMissing === true
        ? { data: null, error: null }
        : {
            data: {
              id: CONSUMER_ID,
              is_suspended: options.isSuspended ?? false,
              suspended_reason: options.suspendedReason ?? null,
            },
            error: null,
          };
    }
    if (op.op === "update") {
      updateCount += 1;
      // The first update is the state change; a second one is the revert.
      if (updateCount === 1 && options.updateError !== undefined && options.updateError !== null) {
        return { data: null, error: options.updateError };
      }
      if (updateCount > 1 && options.revertError !== undefined && options.revertError !== null) {
        return { data: null, error: options.revertError };
      }
      return { data: null, error: null };
    }
    if (op.table === "audit_logs" && op.op === "insert") {
      return { data: null, error: options.auditError ?? null };
    }
    return { data: null, error: null };
  };

  const client = {
    from: (table: string) => new FakeQuery(table, respond, (op) => ops.push(op)),
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return Promise.resolve(
        options.rpcError !== undefined && options.rpcError !== null
          ? { data: null, error: options.rpcError }
          : {
              data:
                options.rpcResult ?? {
                  transaction_id: "txn-1",
                  earn_points: 400,
                  clawed_points: 400,
                  shortfall_points: 0,
                  balance_after: 0,
                },
              error: null,
            },
      );
    },
  };

  return {
    deps: { supabase: client as unknown as SupabaseClient<Database>, now: () => NOW },
    ops,
    rpcs,
    auditRows: () =>
      ops
        .filter((op) => op.table === "audit_logs" && op.op === "insert")
        .map((op) => op.values ?? {}),
    updatesTo: (table) => ops.filter((op) => op.table === table && op.op === "update"),
  };
}

let errorSpy: MockInstance<(...args: unknown[]) => void>;
let warnSpy: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Guard 1: the reason, on every single action
// ---------------------------------------------------------------------------

describe("the mandatory reason", () => {
  const cases = [
    ["applyCooldown", () => applyCooldown({ consumerId: CONSUMER_ID, reason: "", actorId: ADMIN_ID, requestId: "r" }, createWorld().deps)],
    ["liftCooldown", () => liftCooldown({ consumerId: CONSUMER_ID, reason: "   ", actorId: ADMIN_ID, requestId: "r" }, createWorld().deps)],
    ["suspendConsumer", () => suspendConsumer({ profileId: CONSUMER_ID, reason: "", actorId: ADMIN_ID, requestId: "r" }, createWorld().deps)],
    ["unsuspendConsumer", () => unsuspendConsumer({ profileId: CONSUMER_ID, reason: "\t\n", actorId: ADMIN_ID, requestId: "r" }, createWorld().deps)],
    ["clawbackReceipt", () => clawbackReceipt({ receiptId: RECEIPT_ID, reason: "", actorId: ADMIN_ID, requestId: "r" }, createWorld().deps)],
  ] as const;

  for (const [name, run] of cases) {
    it(`${name} refuses without one`, async () => {
      const outcome = await run();
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe("REASON_REQUIRED");
    });
  }

  it("refuses BEFORE touching the database, so a blank reason costs no round trip", async () => {
    const world = createWorld();
    await applyCooldown(
      { consumerId: CONSUMER_ID, reason: " ", actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    expect(world.ops).toHaveLength(0);
  });

  it("refuses a reason too short to be evidence of anything", async () => {
    const world = createWorld();
    const outcome = await applyCooldown(
      { consumerId: CONSUMER_ID, reason: "dupe", actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    expect(world.auditRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Guard 2: the actor, by table truth
// ---------------------------------------------------------------------------

describe("the actor check", () => {
  it("refuses a caller with no active platform_admins row", async () => {
    const world = createWorld({ adminRole: null });
    const outcome = await applyCooldown(
      { consumerId: CONSUMER_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FORBIDDEN");
    expect(world.updatesTo("consumers")).toHaveLength(0);
  });

  it("refuses a support admin, whom doc 01's matrix makes read-only", async () => {
    const world = createWorld({ adminRole: "support" });
    const outcome = await suspendConsumer(
      { profileId: CONSUMER_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FORBIDDEN");
    expect(world.auditRows()).toHaveLength(0);
  });

  it("re-reads the role from the table rather than trusting anything passed in", async () => {
    const world = createWorld({ adminRole: "super_admin" });
    await applyCooldown(
      { consumerId: CONSUMER_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    // The audit row records the authority the action was actually taken under.
    expect(world.auditRows()[0]?.actor_role).toBe("super_admin");
  });
});

// ---------------------------------------------------------------------------
// Ladder step 2: cooldown
// ---------------------------------------------------------------------------

describe("applyCooldown", () => {
  it("blocks scanning and records the action with its reason", async () => {
    const world = createWorld();
    const outcome = await applyCooldown(
      { consumerId: CONSUMER_ID, reason: REASON, actorId: ADMIN_ID, requestId: "req-1" },
      world.deps,
    );

    expect(outcome.ok).toBe(true);
    const update = world.updatesTo("consumers")[0];
    expect(update?.values?.scan_blocked_until).toBe(
      new Date(NOW.getTime() + 24 * 3_600_000).toISOString(),
    );

    const audit = world.auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: ADMIN_ID,
      actor_kind: "admin",
      action: "fraud.cooldown_applied",
      entity_type: "consumer",
      entity_id: CONSUMER_ID,
      reason: REASON,
      request_id: "req-1",
      // doc 25 / 0022: a platform-level action carries no tenant, and a
      // cooldown blocks scanning everywhere rather than at one merchant.
      business_id: null,
    });
  });

  it("records the before and after so the row is a diff, not a copy of the table", async () => {
    const world = createWorld({ scanBlockedUntil: null });
    await applyCooldown(
      { consumerId: CONSUMER_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    const audit = world.auditRows()[0];
    expect(audit?.before).toEqual({ scan_blocked_until: null });
    expect((audit?.after as Record<string, unknown>).hours).toBe(24);
  });

  it("refuses to shorten a block that is already longer", async () => {
    const world = createWorld({
      scanBlockedUntil: new Date(NOW.getTime() + 72 * 3_600_000).toISOString(),
    });
    const outcome = await applyCooldown(
      { consumerId: CONSUMER_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("INVALID_STATE");
    expect(world.updatesTo("consumers")).toHaveLength(0);
  });

  it("reports a missing customer rather than writing into nothing", async () => {
    const world = createWorld({ consumerMissing: true });
    const outcome = await applyCooldown(
      { consumerId: CONSUMER_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("NOT_FOUND");
  });

  it("REVERTS the block when the audit row cannot be written", async () => {
    // An admin action with no audit row behind it is the condition doc 15
    // forbids. Reporting the failure and leaving the block standing would
    // create exactly that.
    const world = createWorld({ auditError: { message: "audit_logs is append-only" } });
    const outcome = await applyCooldown(
      { consumerId: CONSUMER_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("AUDIT_WRITE_FAILED");

    const updates = world.updatesTo("consumers");
    expect(updates).toHaveLength(2);
    expect(updates[1]?.values?.scan_blocked_until).toBeNull();
  });

  it("logs loudly when the revert itself fails, so the gap is discoverable", async () => {
    const world = createWorld({
      auditError: { message: "nope" },
      revertError: { message: "also nope" },
    });
    await applyCooldown(
      { consumerId: CONSUMER_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("UNAUDITED CHANGE"))).toBe(
      true,
    );
  });
});

describe("liftCooldown", () => {
  it("clears the block and records fraud.cooldown_lifted", async () => {
    const world = createWorld({
      scanBlockedUntil: new Date(NOW.getTime() + 3_600_000).toISOString(),
    });
    const outcome = await liftCooldown(
      { consumerId: CONSUMER_ID, reason: "block was applied on evidence that did not hold", actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );

    expect(outcome.ok).toBe(true);
    expect(world.updatesTo("consumers")[0]?.values?.scan_blocked_until).toBeNull();
    expect(world.auditRows()[0]).toMatchObject({
      action: "fraud.cooldown_lifted",
      actor_kind: "admin",
    });
  });

  it("refuses when there is no block to lift", async () => {
    const world = createWorld({ scanBlockedUntil: null });
    const outcome = await liftCooldown(
      { consumerId: CONSUMER_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("INVALID_STATE");
  });
});

// ---------------------------------------------------------------------------
// Ladder step 4: platform suspension
// ---------------------------------------------------------------------------

describe("suspendConsumer", () => {
  it("locks the account and writes the same reason to both the column and the audit row", async () => {
    const world = createWorld();
    const outcome = await suspendConsumer(
      { profileId: CONSUMER_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );

    expect(outcome.ok).toBe(true);
    const update = world.updatesTo("profiles")[0];
    expect(update?.values).toEqual({ is_suspended: true, suspended_reason: REASON });
    // doc 31 §4.3 requires the column and doc 15 requires the audit reason.
    // Writing one string twice is the only way they cannot disagree.
    expect(world.auditRows()[0]).toMatchObject({
      action: "consumer.suspended",
      entity_type: "profile",
      reason: REASON,
    });
  });

  it("refuses a second suspension of an already-suspended account", async () => {
    const world = createWorld({ isSuspended: true });
    const outcome = await suspendConsumer(
      { profileId: CONSUMER_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("INVALID_STATE");
  });

  it("refuses to suspend the acting admin's own account", async () => {
    const world = createWorld();
    const outcome = await suspendConsumer(
      { profileId: ADMIN_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("INVALID_STATE");
    expect(world.updatesTo("profiles")).toHaveLength(0);
  });

  it("reverts the lockout when the audit row cannot be written", async () => {
    const world = createWorld({ auditError: { message: "nope" } });
    const outcome = await suspendConsumer(
      { profileId: CONSUMER_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    const updates = world.updatesTo("profiles");
    expect(updates).toHaveLength(2);
    expect(updates[1]?.values).toEqual({ is_suspended: false, suspended_reason: null });
  });
});

describe("unsuspendConsumer", () => {
  it("clears both columns and records its own verb", async () => {
    const world = createWorld({ isSuspended: true, suspendedReason: "ring member" });
    const outcome = await unsuspendConsumer(
      { profileId: CONSUMER_ID, reason: "appeal upheld after review", actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );

    expect(outcome.ok).toBe(true);
    expect(world.updatesTo("profiles")[0]?.values).toEqual({
      is_suspended: false,
      suspended_reason: null,
    });
    // A reversal recorded under the same verb as the action would make the
    // trail unreadable exactly where it matters.
    expect(world.auditRows()[0]?.action).toBe("consumer.unsuspended");
  });

  it("refuses when the account is not suspended", async () => {
    const world = createWorld({ isSuspended: false });
    const outcome = await unsuspendConsumer(
      { profileId: CONSUMER_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("INVALID_STATE");
  });
});

// ---------------------------------------------------------------------------
// Ladder step 5: clawback
// ---------------------------------------------------------------------------

describe("clawbackReceipt", () => {
  it("delegates the whole thing to the RPC and writes no ledger row of its own", async () => {
    const world = createWorld();
    const outcome = await clawbackReceipt(
      { receiptId: RECEIPT_ID, reason: REASON, actorId: ADMIN_ID, requestId: "req-9" },
      world.deps,
    );

    expect(outcome.ok).toBe(true);
    expect(world.rpcs).toEqual([
      {
        name: "clawback_receipt_points",
        args: {
          p_receipt_id: RECEIPT_ID,
          p_actor_id: ADMIN_ID,
          p_reason: REASON,
          p_request_id: "req-9",
        },
      },
    ]);

    // Doc 35 §11: one implementation of the points rules. Nothing in
    // TypeScript touches the ledger, and the audit row for a clawback is
    // written inside the same transaction as the ledger row, in SQL.
    expect(world.ops.filter((op) => op.table === "points_transactions")).toHaveLength(0);
    expect(world.auditRows()).toHaveLength(0);
  });

  it("reports the clamp so an admin learns what could not be recovered", async () => {
    const world = createWorld({
      rpcResult: {
        transaction_id: "txn-2",
        earn_points: 200,
        clawed_points: 50,
        shortfall_points: 150,
        balance_after: 0,
      },
    });
    const outcome = await clawbackReceipt(
      { receiptId: RECEIPT_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.detail).toEqual({
        earnPoints: 200,
        clawedPoints: 50,
        shortfallPoints: 150,
        balanceAfter: 0,
      });
    }
  });

  it("maps the RPC's CLAWBACK_INVALID_STATE to a sentence, not a stack trace", async () => {
    const world = createWorld({
      rpcError: { message: 'raise exception: CLAWBACK_INVALID_STATE' },
    });
    const outcome = await clawbackReceipt(
      { receiptId: RECEIPT_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("INVALID_STATE");
      expect(outcome.message).toContain("already reversed");
    }
  });

  it("maps CLAWBACK_FORBIDDEN even though the service already checked, because the RPC checks again", async () => {
    const world = createWorld({ rpcError: { message: "CLAWBACK_FORBIDDEN" } });
    const outcome = await clawbackReceipt(
      { receiptId: RECEIPT_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FORBIDDEN");
  });

  it("does not tell an admin to retry a clawback that committed but returned an unreadable shape", async () => {
    const world = createWorld({ rpcResult: { unexpected: true } });
    const outcome = await clawbackReceipt(
      { receiptId: RECEIPT_ID, reason: REASON, actorId: ADMIN_ID, requestId: "r" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("went through");
  });
});
