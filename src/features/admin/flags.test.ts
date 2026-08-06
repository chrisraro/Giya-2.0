// @vitest-environment node
//
// `/admin/flags`: the list read (`loadFeatureFlags`) and the toggle
// (`toggleFeatureFlag`) - doc 31 section 7's screen, super_admin only, every
// change audited. Mirrors `jobs.test.ts`'s shape for the same reason:
// `toggleFeatureFlag` is `replayJob`'s sibling (mandatory reason, table-truth
// actor check, write-then-audit-else-revert).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { loadFeatureFlags, toggleFeatureFlag } from "./flags";
import type { AdminFlagsDeps } from "./flags";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const REASON = "operator asked us to pause parse-assist during a Groq incident";

interface FlagFixture {
  key: string;
  description: string;
  is_enabled: boolean;
  rollout: unknown;
  updated_at: string;
  updated_by: string | null;
}

const ORIGINAL_ACTOR_ID = "99999999-9999-4999-8999-999999999999";
const THIRD_ADMIN_ID = "33333333-3333-4333-8333-333333333333";

function flag(overrides: Partial<FlagFixture> = {}): FlagFixture {
  return {
    key: "ai_parse_assist",
    description: "LLM tier-3 fill-gap extraction.",
    is_enabled: true,
    rollout: {},
    updated_at: "2026-08-06T00:00:00.000Z",
    updated_by: ORIGINAL_ACTOR_ID,
    ...overrides,
  };
}

interface WorldOptions {
  flags?: FlagFixture[];
  adminRole?: string | null;
  adminReadError?: { message: string } | null;
  flagListError?: { message: string } | null;
  flagReadError?: { message: string } | null;
  /** Applies to the FORWARD CAS write only (the first `.update()` call this
   * toggle issues against `feature_flags`). */
  writeError?: { message: string; code?: string } | null;
  auditError?: { message: string } | null;
  /** Applies to the REVERT write only (the second `.update()` call, issued
   * only when the audit insert failed). Distinguished from `writeError` by
   * CALL ORDER, not by shape - both writes are now the identical
   * `.eq(...).eq(...).select(...).maybeSingle()` chain shape (review
   * finding #7 made the revert CAS-guarded too), so shape can no longer
   * tell them apart the way it could before that fix. */
  revertError?: { message: string } | null;
  /** Mutates the store AFTER this call's pre-write read but as part of the
   * FORWARD write attempt itself - the race the `.eq("is_enabled", prior)`
   * predicate has to catch. Fires once, then set back to `undefined`
   * (declared explicitly in the type, `exactOptionalPropertyTypes`). */
  raceBeforeWrite?: ((store: Map<string, FlagFixture>) => void) | undefined;
  /** Mutates the store AFTER the forward write but BEFORE the revert's own
   * CAS write - review finding #7's "a third admin changes it again before
   * the revert runs" race. Fires once, only ever consulted by the SECOND
   * `.update()` call (the revert). */
  raceBeforeRevert?: ((store: Map<string, FlagFixture>) => void) | undefined;
}

interface FakeResult {
  data: unknown;
  error: unknown;
}

/** A thenable `.eq(...).eq(...).select(...).maybeSingle()` chain over the
 * in-memory flag store. `updateIndex` (0 = the forward CAS write, 1 = the
 * revert, assigned by call ORDER in `createWorld` below) is what picks the
 * error channel and the race hook now that both writes share one shape. */
class UpdateChain implements PromiseLike<FakeResult> {
  private readonly filters: Array<{ column: string; value: unknown }> = [];

  constructor(
    private readonly store: Map<string, FlagFixture>,
    private readonly patch: Record<string, unknown>,
    private readonly options: WorldOptions,
    private readonly updateIndex: number,
  ) {}

  eq(column: string, value: unknown): this {
    this.filters.push({ column, value });
    return this;
  }

  select(): this {
    return this;
  }

  maybeSingle(): this {
    return this;
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onFulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.resolve())
      .then(onFulfilled, onRejected);
  }

  private resolve(): FakeResult {
    const isRevert = this.updateIndex === 1;
    const scriptedError = isRevert ? this.options.revertError : this.options.writeError;
    if (scriptedError !== undefined && scriptedError !== null) {
      return { data: null, error: scriptedError };
    }

    const keyFilter = this.filters.find((f) => f.column === "key");
    if (keyFilter === undefined) return { data: null, error: null };

    if (!isRevert && this.options.raceBeforeWrite !== undefined) {
      this.options.raceBeforeWrite(this.store);
      this.options.raceBeforeWrite = undefined;
    }
    if (isRevert && this.options.raceBeforeRevert !== undefined) {
      this.options.raceBeforeRevert(this.store);
      this.options.raceBeforeRevert = undefined;
    }

    const row = this.store.get(String(keyFilter.value));
    if (row === undefined) return { data: null, error: null };

    const matches = this.filters.every((f) =>
      f.column === "key" ? true : (row as unknown as Record<string, unknown>)[f.column] === f.value,
    );
    if (!matches) return { data: null, error: null };

    Object.assign(row, this.patch);
    return { data: { ...row }, error: null };
  }
}

function createWorld(options: WorldOptions = {}) {
  const store = new Map<string, FlagFixture>(
    (options.flags ?? [flag()]).map((row) => [row.key, row]),
  );
  const auditInserts: Array<Record<string, unknown>> = [];
  const updateCalls: Array<Record<string, unknown>> = [];

  const client = {
    from(table: string) {
      if (table === "feature_flags") {
        return {
          select() {
            return {
              order() {
                if (options.flagListError !== undefined && options.flagListError !== null) {
                  return Promise.resolve({ data: null, error: options.flagListError });
                }
                return Promise.resolve({
                  data: [...store.values()].sort((a, b) => a.key.localeCompare(b.key)),
                  error: null,
                });
              },
              eq(_column: string, value: string) {
                return {
                  maybeSingle() {
                    if (options.flagReadError !== undefined && options.flagReadError !== null) {
                      return Promise.resolve({ data: null, error: options.flagReadError });
                    }
                    // A COPY, not the live row reference: the real Supabase
                    // client never hands back a value that later mutates
                    // out from under the caller, and `current` is exactly
                    // what the audit row's `before` is built from.
                    const row = store.get(value);
                    return Promise.resolve({ data: row === undefined ? null : { ...row }, error: null });
                  },
                };
              },
            };
          },
          update(patch: Record<string, unknown>) {
            const updateIndex = updateCalls.length;
            updateCalls.push(patch);
            return new UpdateChain(store, patch, options, updateIndex);
          },
        };
      }

      if (table === "platform_admins") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => {
                  if (options.adminReadError !== undefined && options.adminReadError !== null) {
                    return Promise.resolve({ data: null, error: options.adminReadError });
                  }
                  if (options.adminRole === undefined || options.adminRole === null) {
                    return Promise.resolve({ data: null, error: null });
                  }
                  return Promise.resolve({
                    data: { role: options.adminRole, is_active: true },
                    error: null,
                  });
                },
              }),
            }),
          }),
        };
      }

      if (table === "audit_logs") {
        return {
          insert: (row: Record<string, unknown>) => {
            if (options.auditError !== undefined && options.auditError !== null) {
              return Promise.resolve({ error: options.auditError });
            }
            auditInserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }

      throw new Error(`unexpected table in flags.test.ts fake: ${table}`);
    },
  };

  const deps: AdminFlagsDeps = { supabase: client as unknown as SupabaseClient<Database> };

  return { deps, store, auditInserts, updateCalls };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// loadFeatureFlags
// ---------------------------------------------------------------------------

describe("loadFeatureFlags", () => {
  it("returns null (not []) when there is no service-role client", async () => {
    const result = await loadFeatureFlags(null);
    expect(result).toBeNull();
    // Named mutant: return `[]` instead of `null` when `deps === null`.
    // Killed - the screen must not read an unavailable dependency as "the
    // registry is genuinely empty".
  });

  it("lists every flag, mapped to the screen's own shape", async () => {
    const world = createWorld({
      flags: [
        flag({ key: "ai_assistant", is_enabled: false }),
        flag({ key: "ai_parse_assist", is_enabled: true }),
      ],
    });

    const result = await loadFeatureFlags(world.deps);

    expect(result).toEqual([
      {
        key: "ai_assistant",
        description: "LLM tier-3 fill-gap extraction.",
        isEnabled: false,
        updatedAt: "2026-08-06T00:00:00.000Z",
      },
      {
        key: "ai_parse_assist",
        description: "LLM tier-3 fill-gap extraction.",
        isEnabled: true,
        updatedAt: "2026-08-06T00:00:00.000Z",
      },
    ]);
    // Named mutant: read `rollout` into `isEnabled`, or map `is_enabled`
    // into a differently-named field. Killed by the exact-shape equality.
  });

  it("returns null (not []) on a read failure", async () => {
    const world = createWorld({ flagListError: { message: "connection reset" } });

    const result = await loadFeatureFlags(world.deps);

    expect(result).toBeNull();
    // Named mutant: swallow the error and return `[]`. Killed - a failed
    // read of the platform's own kill switches must not render as "there is
    // nothing to turn off".
  });
});

// ---------------------------------------------------------------------------
// toggleFeatureFlag: the mandatory reason
// ---------------------------------------------------------------------------

describe("toggleFeatureFlag: the mandatory reason", () => {
  it("refuses a blank reason before touching the database", async () => {
    const world = createWorld();

    const outcome = await toggleFeatureFlag(
      { key: "ai_parse_assist", isEnabled: false, actorId: ADMIN_ID, reason: "   ", requestId: "r1" },
      world.deps,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("REASON_REQUIRED");
    expect(world.updateCalls).toHaveLength(0);
    expect(world.auditInserts).toHaveLength(0);
  });

  // Mutant: use a laxer length check than `reasonProblem`'s own
  // `MIN_REASON_LENGTH` (e.g. accept any non-empty string).
  it("refuses a reason too short to be evidence of anything", async () => {
    const world = createWorld();

    const outcome = await toggleFeatureFlag(
      { key: "ai_parse_assist", isEnabled: false, actorId: ADMIN_ID, reason: "off", requestId: "r1" },
      world.deps,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("REASON_REQUIRED");
    expect(world.updateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// toggleFeatureFlag: the actor check (a non-admin cannot toggle a flag)
// ---------------------------------------------------------------------------

describe("toggleFeatureFlag: the actor check", () => {
  // Mutant: skip the table-truth read and trust the caller's role. This is
  // the "assert the refusal" test the brief asks for at the data layer.
  it("refuses a caller with no active platform_admins row", async () => {
    const world = createWorld({ adminRole: null });

    const outcome = await toggleFeatureFlag(
      { key: "ai_parse_assist", isEnabled: false, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FORBIDDEN");
    expect(world.updateCalls).toHaveLength(0);
    expect(world.auditInserts).toHaveLength(0);
    expect(world.store.get("ai_parse_assist")?.is_enabled).toBe(true); // unchanged
  });

  // Mutant: reuse `canActOnLadder` (admin OR super_admin) instead of a
  // super_admin-only predicate. Doc 31 section 1 scopes this screen to
  // super_admin only - unlike the queue replay screen, which allows admin.
  it("refuses a plain admin (allowed to replay jobs, not allowed to flip a kill switch)", async () => {
    const world = createWorld({ adminRole: "admin" });

    const outcome = await toggleFeatureFlag(
      { key: "ai_parse_assist", isEnabled: false, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FORBIDDEN");
    expect(world.updateCalls).toHaveLength(0);
  });

  it("refuses a support-role admin, who is read-only everywhere", async () => {
    const world = createWorld({ adminRole: "support" });

    const outcome = await toggleFeatureFlag(
      { key: "ai_parse_assist", isEnabled: false, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FORBIDDEN");
  });

  // Mutant: refuse every role, including super_admin (an inverted or
  // always-false predicate).
  it("allows an active super_admin", async () => {
    const world = createWorld({ adminRole: "super_admin" });

    const outcome = await toggleFeatureFlag(
      { key: "ai_parse_assist", isEnabled: false, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );

    expect(outcome.ok).toBe(true);
  });

  it("reports a database fault verifying the actor as FORBIDDEN, not a crash", async () => {
    const world = createWorld({ adminReadError: { message: "connection reset" } });

    const outcome = await toggleFeatureFlag(
      { key: "ai_parse_assist", isEnabled: false, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// toggleFeatureFlag: the subject and its state
// ---------------------------------------------------------------------------

describe("toggleFeatureFlag: the subject and its state", () => {
  it("reports an unknown key as NOT_FOUND", async () => {
    const world = createWorld({ adminRole: "super_admin", flags: [] });

    const outcome = await toggleFeatureFlag(
      { key: "no_such_flag", isEnabled: true, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("NOT_FOUND");
  });

  it("reports NO_CHANGE and writes nothing when the target state matches the live row", async () => {
    const world = createWorld({ adminRole: "super_admin", flags: [flag({ is_enabled: true })] });

    const outcome = await toggleFeatureFlag(
      { key: "ai_parse_assist", isEnabled: true, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("NO_CHANGE");
    expect(world.updateCalls).toHaveLength(0);
    expect(world.auditInserts).toHaveLength(0);
    // Named mutant: skip the `current.is_enabled === input.isEnabled` guard
    // and always write + audit. Killed by the empty updateCalls/auditInserts
    // - a no-op toggle must never mint an audit row claiming a change.
  });
});

// ---------------------------------------------------------------------------
// toggleFeatureFlag: the write and the audit row (every toggle writes
// EXACTLY ONE audit row)
// ---------------------------------------------------------------------------

describe("toggleFeatureFlag: the write and the audit row", () => {
  it("flips is_enabled and writes exactly one audit row with the admin verb, actor and reason", async () => {
    const world = createWorld({ adminRole: "super_admin", flags: [flag({ is_enabled: true })] });

    const outcome = await toggleFeatureFlag(
      { key: "ai_parse_assist", isEnabled: false, actorId: ADMIN_ID, reason: REASON, requestId: "req-1" },
      world.deps,
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.item.isEnabled).toBe(false);
    expect(world.store.get("ai_parse_assist")?.is_enabled).toBe(false);

    expect(world.auditInserts).toHaveLength(1);
    const row = world.auditInserts[0];
    expect(row).toMatchObject({
      actor_id: ADMIN_ID,
      actor_kind: "admin",
      actor_role: "super_admin",
      action: "flag.updated",
      entity_type: "feature_flag",
      reason: REASON,
      request_id: "req-1",
    });
    expect(row?.before).toMatchObject({ key: "ai_parse_assist", is_enabled: true });
    expect(row?.after).toMatchObject({ key: "ai_parse_assist", is_enabled: false });
    // Named mutant: write the audit row TWICE (once "for safety") or write
    // it before the CAS write succeeds. Killed by the length===1 assertion
    // and by before/after reflecting the actual prior/new values.
  });

  it("guards the write on the flag's PRIOR value (CAS), so a concurrent toggle loses cleanly", async () => {
    const world = createWorld({
      adminRole: "super_admin",
      flags: [flag({ is_enabled: true })],
      // Between this call's read and its CAS write, another admin already
      // turned the flag off.
      raceBeforeWrite: (store) => {
        const row = store.get("ai_parse_assist");
        if (row !== undefined) row.is_enabled = false;
      },
    });

    const outcome = await toggleFeatureFlag(
      { key: "ai_parse_assist", isEnabled: false, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("WRITE_FAILED");
    expect(world.auditInserts).toHaveLength(0);
    // Named mutant: drop the second `.eq("is_enabled", current.is_enabled)`
    // predicate from the update chain. Killed - without it the race above
    // would silently "succeed" (writing false over an already-false row)
    // instead of losing to the concurrent admin's change.
  });

  it("reverts the write when the audit insert fails, and reports AUDIT_WRITE_FAILED", async () => {
    const world = createWorld({
      adminRole: "super_admin",
      flags: [flag({ is_enabled: true })],
      auditError: { message: "connection reset" },
    });

    const outcome = await toggleFeatureFlag(
      { key: "ai_parse_assist", isEnabled: false, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("AUDIT_WRITE_FAILED");
    // The revert put it back: an unaudited state change must not survive.
    expect(world.store.get("ai_parse_assist")?.is_enabled).toBe(true);
    // Named mutant: report AUDIT_WRITE_FAILED without reverting the row
    // (drop the `await revertToggle(...)` call). Killed - the row would
    // still read `false`, an unaudited change no reader can account for.
  });

  // Review finding #7 (part 1): the revert must restore `updated_by` to
  // the PRIOR actor, not leave the row attributed to the actor whose
  // toggle was rolled back.
  it("restores updated_by to the prior actor when reverting a failed toggle (review finding #7)", async () => {
    const world = createWorld({
      adminRole: "super_admin",
      flags: [flag({ is_enabled: true, updated_by: ORIGINAL_ACTOR_ID })],
      auditError: { message: "connection reset" },
    });

    await toggleFeatureFlag(
      { key: "ai_parse_assist", isEnabled: false, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );

    expect(world.store.get("ai_parse_assist")?.updated_by).toBe(ORIGINAL_ACTOR_ID);
    // Named mutant: revert `is_enabled` only, leaving `updated_by` at
    // whatever the forward (failed) write set it to. Killed - the row
    // would stay attributed to `ADMIN_ID`, a false record of who last
    // legitimately touched a flag that ADMIN_ID's own toggle never
    // actually took effect on.
  });

  // Review finding #7 (part 2): the revert is CAS-guarded on the value
  // THIS toggle wrote, so it cannot clobber a newer change a third admin
  // made in the window between the forward write and the failed audit
  // insert.
  it("does not clobber a third admin's newer change when reverting (review finding #7, CAS-guarded)", async () => {
    const world = createWorld({
      adminRole: "super_admin",
      flags: [flag({ is_enabled: true, updated_by: ORIGINAL_ACTOR_ID })],
      auditError: { message: "connection reset" },
      // Fires only for the SECOND update call (the revert): a third admin
      // already turned the flag back on again, attributed to themselves,
      // before this toggle's revert runs.
      raceBeforeRevert: (store) => {
        const row = store.get("ai_parse_assist");
        if (row !== undefined) {
          row.is_enabled = true;
          row.updated_by = THIRD_ADMIN_ID;
        }
      },
    });

    const outcome = await toggleFeatureFlag(
      { key: "ai_parse_assist", isEnabled: false, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("AUDIT_WRITE_FAILED");
    // The third admin's change survives untouched - reverting it would
    // destroy a DIFFERENT toggle that has nothing to do with this one's
    // failed audit write.
    expect(world.store.get("ai_parse_assist")?.is_enabled).toBe(true);
    expect(world.store.get("ai_parse_assist")?.updated_by).toBe(THIRD_ADMIN_ID);
    // Named mutant: drop the `.eq("is_enabled", writtenIsEnabled)` CAS
    // predicate from the revert's update chain (revert unconditionally).
    // Killed - without it, the revert would overwrite the third admin's
    // `is_enabled: true, updated_by: THIRD_ADMIN_ID` with the original
    // actor's prior state, silently erasing a change this toggle's own
    // failure has no business touching.
  });

  it("does not throw when the audit write fails AND the revert itself fails", async () => {
    const world = createWorld({
      adminRole: "super_admin",
      flags: [flag({ is_enabled: true })],
      auditError: { message: "connection reset" },
      revertError: { message: "also down" },
    });

    await expect(
      toggleFeatureFlag(
        { key: "ai_parse_assist", isEnabled: false, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
        world.deps,
      ),
    ).resolves.toMatchObject({ ok: false, code: "AUDIT_WRITE_FAILED" });
    // Named mutant: let the revert's own error propagate as an unhandled
    // rejection instead of being logged. Killed - this must resolve, never
    // reject, even when both writes in the failure path fail.
  });
});

// ---------------------------------------------------------------------------
// No service-role client at all
// ---------------------------------------------------------------------------

describe("toggleFeatureFlag: dependency unavailable", () => {
  it("reports DEPENDENCY_UNAVAILABLE rather than throwing when deps is null", async () => {
    const outcome = await toggleFeatureFlag(
      { key: "ai_parse_assist", isEnabled: false, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      null,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("DEPENDENCY_UNAVAILABLE");
  });
});
