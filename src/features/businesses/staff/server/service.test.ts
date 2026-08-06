// @vitest-environment node
//
// server/service.ts's own header explains WHY every write here goes through a
// service-role client (business_staff has no client write policy at all) and
// WHY audit failures revert the write rather than best-effort logging it
// (admin/jobs.ts's shape, not campaigns'/customers'). This file proves both,
// plus the two refusals the brief calls out as the ones that matter most:
// a non-owner/manager cannot invite, and an invalid/expired/already-used
// token cannot grant membership.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  function makeBuilder() {
    const builder: Record<string, unknown> = {
      __result: { data: null, error: null } as { data: unknown; error: unknown },
    };
    for (const method of ["select", "insert", "update", "delete", "eq", "neq", "in", "order", "limit"]) {
      builder[method] = vi.fn(() => builder);
    }
    builder.single = vi.fn(async () => builder.__result);
    builder.maybeSingle = vi.fn(async () => builder.__result);
    builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(builder.__result).then(resolve, reject);
    return builder;
  }

  return {
    makeBuilder,
    getUser: vi.fn(),
    sessionFrom: vi.fn(),
    serviceFrom: vi.fn(),
    serviceClient: vi.fn(),
    generateLink: vi.fn(),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.sessionFrom,
  })),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: mocks.serviceClient,
}));

vi.mock("./notify", () => ({ sendStaffInviteEmail: vi.fn(async () => undefined) }));

const service = await import("./service");
const { sendStaffInviteEmail } = await import("./notify");

type Builder = ReturnType<typeof mocks.makeBuilder>;

const BUSINESS = { id: "biz-1", name: "Kape Diaria" };
const OWNER_ACTOR = { userId: "owner-1", role: "owner" as const };
const MANAGER_ACTOR = { userId: "manager-1", role: "manager" as const };
const STAFF_ACTOR = { userId: "staff-1", role: "staff" as const };
const INVITEE_USER_ID = "invitee-1";

let serviceBuilders: Record<string, Builder>;

function serviceTable(name: string): Builder {
  const b = serviceBuilders[name];
  if (!b) throw new Error(`no service-role mock builder registered for table "${name}"`);
  // Filtering-fake builders (I4's cross-tenant suite) expose `__reset`,
  // called once per `.from(name)` - i.e. once per query chain - so their
  // per-chain filter/patch state cannot leak from one call into the next.
  // No-op for the plain `makeBuilder()` fakes everywhere else in this file.
  (b as unknown as { __reset?: () => void }).__reset?.();
  return b;
}

function firstCallArg(builder: Builder, method: string): Record<string, unknown> {
  const fn = builder[method] as { mock: { calls: unknown[][] } };
  return (fn.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
}

/**
 * Sequences a table's `.single()`/`.maybeSingle()` results ACROSS calls, in
 * the order the code under test issues them - needed once a single test
 * exercises more than one query on the same table (insert, then a lookup,
 * then an update), which the shared `__result` field cannot express since it
 * answers every terminal call the same way. Shared between `.single` and
 * `.maybeSingle` because service.ts mixes both within one function and the
 * call ORDER, not which specific method, is what matters here.
 */
function queueResults(table: Builder, results: Array<{ data: unknown; error: unknown }>): void {
  let i = 0;
  const next = () => (i < results.length ? results[i++]! : results[results.length - 1]!);
  table.single = vi.fn(async () => next());
  table.maybeSingle = vi.fn(async () => next());
}

function baseStaffRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "staff-row-1",
    business_id: BUSINESS.id,
    user_id: INVITEE_USER_ID,
    role: "staff",
    status: "invited",
    invited_email: "new@example.com",
    invite_token: "tok_live",
    invite_expires_at: "2099-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  serviceBuilders = {
    business_staff: mocks.makeBuilder(),
    audit_logs: mocks.makeBuilder(),
    businesses: mocks.makeBuilder(),
  };
  serviceTable("audit_logs").insert = vi.fn(() => ({ error: null }));
  serviceTable("businesses").__result = { data: { name: "Kape Diaria" }, error: null };

  mocks.serviceFrom.mockImplementation((name: string) => serviceTable(name));
  mocks.serviceClient.mockReturnValue({
    from: mocks.serviceFrom,
    auth: { admin: { generateLink: mocks.generateLink } },
  });
  mocks.generateLink.mockResolvedValue({
    data: { user: { id: INVITEE_USER_ID }, properties: { action_link: null } },
    error: null,
  });
});

// ===========================================================================
// invite: the target-role refusal (owner can invite anyone but owner;
// manager only staff)
// ===========================================================================

describe("inviteStaff: role gating", () => {
  it("an owner may invite a manager", async () => {
    serviceTable("business_staff").__result = { data: baseStaffRow({ role: "manager" }), error: null };

    const result = await service.inviteStaff(BUSINESS, OWNER_ACTOR, {
      email: "new@example.com",
      role: "manager",
    });

    expect(result.ok).toBe(true);
  });

  it("a manager cannot invite a manager (refusal asserted, not a hidden option)", async () => {
    // Mutant this catches: `canActOnRole` returning true unconditionally, or
    // this check being skipped, would let the insert below run - the
    // `not.toHaveBeenCalled` line fails independently of `result.ok`, so a
    // mutant that flips the message but still refuses is NOT what this pins.
    const result = await service.inviteStaff(BUSINESS, MANAGER_ACTOR, {
      email: "new@example.com",
      role: "manager",
    });

    expect(result.ok).toBe(false);
    // Review fix M11: the previous version of this line
    // (`expect(result.ok || result.code).not.toBe(true)`) could never fail -
    // `false || "NOT_ALLOWED"` is the string "NOT_ALLOWED", which is never
    // `=== true` regardless of what the code actually is. Asserting the code
    // directly is what the comment above always claimed this line did.
    expect(!result.ok && result.code).toBe("NOT_ALLOWED");
    expect(serviceTable("business_staff").insert).not.toHaveBeenCalled();
  });

  it("a manager may invite a staff member", async () => {
    serviceTable("business_staff").__result = { data: baseStaffRow(), error: null };

    const result = await service.inviteStaff(BUSINESS, MANAGER_ACTOR, {
      email: "new@example.com",
      role: "staff",
    });

    expect(result.ok).toBe(true);
  });

  it("nobody can invite an owner - ownership is not grantable by invite", async () => {
    const result = await service.inviteStaff(BUSINESS, OWNER_ACTOR, {
      email: "new@example.com",
      role: "owner",
    });

    expect(result.ok).toBe(false);
    expect(serviceTable("business_staff").insert).not.toHaveBeenCalled();
  });

  it("a plain staff member cannot invite at all (the roster gate's own refusal, mirrored here in depth)", async () => {
    const result = await service.inviteStaff(BUSINESS, STAFF_ACTOR, {
      email: "new@example.com",
      role: "staff",
    });

    expect(result.ok).toBe(false);
    expect(serviceTable("business_staff").insert).not.toHaveBeenCalled();
  });
});

describe("inviteStaff: writing the row", () => {
  it("inserts invited/token/expiry/email and the resolved invitee's user_id", async () => {
    serviceTable("business_staff").__result = { data: baseStaffRow(), error: null };

    await service.inviteStaff(BUSINESS, OWNER_ACTOR, { email: "new@example.com", role: "staff" });

    const patch = firstCallArg(serviceTable("business_staff"), "insert");
    expect(patch.status).toBe("invited");
    expect(patch.invited_email).toBe("new@example.com");
    expect(patch.user_id).toBe(INVITEE_USER_ID);
    expect(patch.role).toBe("staff");
    expect(typeof patch.invite_token).toBe("string");
    expect((patch.invite_token as string).length).toBeGreaterThan(20);
  });

  it("maps a unique-violation to INVITE_DUPLICATE when the existing row is still LIVE (active member)", async () => {
    // Mutant: forgetting the `error.code === "23505"` branch (or checking the
    // wrong code) would fall through to the generic message and lose the
    // caller-facing code doc 32 registers for this case.
    const table = serviceTable("business_staff");
    queueResults(table, [
      { data: null, error: { code: "23505", message: "duplicate key" } }, // insert
      { data: baseStaffRow({ status: "active" }), error: null }, // existing-row lookup
    ]);

    const result = await service.inviteStaff(BUSINESS, OWNER_ACTOR, {
      email: "existing@example.com",
      role: "staff",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("INVITE_DUPLICATE");
    expect(table.update).not.toHaveBeenCalled();
  });

  it("maps a unique-violation to INVITE_DUPLICATE when the existing invite is still pending and NOT expired", async () => {
    const table = serviceTable("business_staff");
    queueResults(table, [
      { data: null, error: { code: "23505", message: "duplicate key" } },
      {
        data: baseStaffRow({ status: "invited", invite_expires_at: "2099-01-01T00:00:00.000Z" }),
        error: null,
      },
    ]);

    const result = await service.inviteStaff(BUSINESS, OWNER_ACTOR, {
      email: "existing@example.com",
      role: "staff",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("INVITE_DUPLICATE");
    expect(table.update).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // C1 (review fix): a unique-violation against a REVOKED or EXPIRED invite
  // must reactivate the row, not permanently brick that email. Doc 32 §7.1:
  // "Resend regenerates token." Before this fix, `business_staff`'s own
  // `unique(business_id, user_id)` (0002:279) meant a SECOND invite to
  // anyone whose first one expired (7-day TTL, doc 30 §2.7) or was revoked
  // hit 23505 forever, reported as INVITE_DUPLICATE with no recovery path.
  // ===========================================================================

  it("reactivates a REVOKED invite (status='disabled') instead of permanently refusing it", async () => {
    // Mutant: treating every 23505 as a hard duplicate (the pre-fix
    // behaviour) makes this assert result.ok===false instead of true, and
    // never issues the reactivating UPDATE at all.
    const table = serviceTable("business_staff");
    const disabled = baseStaffRow({ status: "disabled", invite_token: null, role: "staff" });
    queueResults(table, [
      { data: null, error: { code: "23505", message: "duplicate key" } }, // insert
      { data: disabled, error: null }, // existing-row lookup
      { data: baseStaffRow({ status: "invited", role: "staff" }), error: null }, // reactivate update
    ]);

    const result = await service.inviteStaff(BUSINESS, OWNER_ACTOR, {
      email: "new@example.com",
      role: "staff",
    });

    expect(result.ok).toBe(true);
    const patch = firstCallArg(table, "update");
    expect(patch.status).toBe("invited");
    expect(typeof patch.invite_token).toBe("string");
    expect((patch.invite_token as string).length).toBeGreaterThan(20);
  });

  it("reactivates an EXPIRED invite (status still 'invited', past invite_expires_at) instead of refusing it", async () => {
    const table = serviceTable("business_staff");
    const expired = baseStaffRow({ status: "invited", invite_expires_at: "2020-01-01T00:00:00.000Z" });
    queueResults(table, [
      { data: null, error: { code: "23505", message: "duplicate key" } },
      { data: expired, error: null },
      { data: baseStaffRow({ status: "invited" }), error: null },
    ]);

    const result = await service.inviteStaff(BUSINESS, OWNER_ACTOR, {
      email: "new@example.com",
      role: "staff",
    });

    expect(result.ok).toBe(true);
    expect(firstCallArg(table, "update").status).toBe("invited");
  });

  it("a reactivation writes exactly one audit row, action staff.invite_resent", async () => {
    const table = serviceTable("business_staff");
    const disabled = baseStaffRow({ status: "disabled", invite_token: null });
    queueResults(table, [
      { data: null, error: { code: "23505", message: "duplicate key" } },
      { data: disabled, error: null },
      { data: baseStaffRow({ status: "invited" }), error: null },
    ]);

    await service.inviteStaff(BUSINESS, OWNER_ACTOR, { email: "new@example.com", role: "staff" });

    expect(serviceTable("audit_logs").insert).toHaveBeenCalledTimes(1);
    expect(firstCallArg(serviceTable("audit_logs"), "insert").action).toBe("staff.invite_resent");
  });

  it("reverts a reactivation to its EXACT prior fields when the audit write fails", async () => {
    // Mutant: reverting to a hardcoded/default state instead of the row's
    // own previous snapshot would leave a revoked row looking 'invited', or
    // vice versa - a corrupted, unaudited state, exactly what write-then-
    // audit-else-revert exists to prevent.
    const table = serviceTable("business_staff");
    const disabled = baseStaffRow({
      status: "disabled",
      role: "manager",
      invite_token: null,
      invited_email: "old@example.com",
      invite_expires_at: "2020-01-01T00:00:00.000Z",
    });
    queueResults(table, [
      { data: null, error: { code: "23505", message: "duplicate key" } },
      { data: disabled, error: null },
      { data: baseStaffRow({ status: "invited" }), error: null },
    ]);
    serviceTable("audit_logs").insert = vi.fn(() => ({ error: { message: "boom" } }));

    const result = await service.inviteStaff(BUSINESS, OWNER_ACTOR, {
      email: "new@example.com",
      role: "staff",
    });

    expect(result.ok).toBe(false);
    const calls = (table.update as { mock: { calls: unknown[][] } }).mock.calls;
    const revertPatch = calls[calls.length - 1]?.[0] as Record<string, unknown>;
    expect(revertPatch.status).toBe("disabled");
    expect(revertPatch.role).toBe("manager");
    expect(revertPatch.invited_email).toBe("old@example.com");
    expect(revertPatch.invite_token).toBeNull();
  });

  it("writes exactly one audit_logs row, action staff.invited", async () => {
    serviceTable("business_staff").__result = { data: baseStaffRow(), error: null };

    await service.inviteStaff(BUSINESS, OWNER_ACTOR, { email: "new@example.com", role: "staff" });

    expect(serviceTable("audit_logs").insert).toHaveBeenCalledTimes(1);
    const auditRow = firstCallArg(serviceTable("audit_logs"), "insert");
    expect(auditRow.action).toBe("staff.invited");
    expect(auditRow.entity_type).toBe("business_staff");
  });

  it("reverts (deletes) the row when the audit write fails, and reports failure", async () => {
    // Mutant: dropping the revert call, or reporting ok:true despite the
    // audit failure, would leave an unaudited privilege-bearing row in place
    // - exactly what this module's header argues must never happen.
    serviceTable("business_staff").__result = { data: baseStaffRow(), error: null };
    serviceTable("audit_logs").insert = vi.fn(() => ({ error: { message: "boom" } }));

    const result = await service.inviteStaff(BUSINESS, OWNER_ACTOR, {
      email: "new@example.com",
      role: "staff",
    });

    expect(result.ok).toBe(false);
    expect(serviceTable("business_staff").delete).toHaveBeenCalled();
  });

  it("sends the invite email with the minted token, best-effort", async () => {
    serviceTable("business_staff").__result = { data: baseStaffRow(), error: null };

    await service.inviteStaff(BUSINESS, OWNER_ACTOR, { email: "new@example.com", role: "staff" });

    expect(sendStaffInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "new@example.com", businessName: "Kape Diaria", role: "staff" }),
    );
  });

  it("refuses cleanly (never throws) when no service-role key is configured", async () => {
    mocks.serviceClient.mockReturnValue(null);

    const result = await service.inviteStaff(BUSINESS, OWNER_ACTOR, {
      email: "new@example.com",
      role: "staff",
    });

    expect(result.ok).toBe(false);
  });
});

// ===========================================================================
// revoke: makes the token unusable
// ===========================================================================

describe("revokeInvite", () => {
  it("nulls the token and disables the row, guarded by a live invited status", async () => {
    const existing = baseStaffRow();
    const table = serviceTable("business_staff");
    table.select = vi.fn(() => table);
    table.__result = { data: existing, error: null };

    await service.revokeInvite(BUSINESS, OWNER_ACTOR, existing.id);

    const patch = firstCallArg(table, "update");
    expect(patch.invite_token).toBeNull();
    expect(patch.status).toBe("disabled");
  });

  it("a manager cannot revoke a manager's invite (target-role refusal)", async () => {
    const existing = baseStaffRow({ role: "manager" });
    serviceTable("business_staff").__result = { data: existing, error: null };

    const result = await service.revokeInvite(BUSINESS, MANAGER_ACTOR, existing.id);

    expect(result.ok).toBe(false);
    expect(serviceTable("business_staff").update).not.toHaveBeenCalled();
  });

  it("writes exactly one audit row, action staff.invite_revoked", async () => {
    const existing = baseStaffRow();
    serviceTable("business_staff").__result = { data: existing, error: null };

    await service.revokeInvite(BUSINESS, OWNER_ACTOR, existing.id);

    expect(serviceTable("audit_logs").insert).toHaveBeenCalledTimes(1);
    expect(firstCallArg(serviceTable("audit_logs"), "insert").action).toBe("staff.invite_revoked");
  });

  it("restores the original token when the audit write fails", async () => {
    const existing = baseStaffRow();
    serviceTable("business_staff").__result = { data: existing, error: null };
    serviceTable("audit_logs").insert = vi.fn(() => ({ error: { message: "boom" } }));

    const result = await service.revokeInvite(BUSINESS, OWNER_ACTOR, existing.id);

    expect(result.ok).toBe(false);
    // Two updates: the revoke, then the revert restoring the live token.
    const table = serviceTable("business_staff");
    const calls = (table.update as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(2);
    expect((calls[1]?.[0] as Record<string, unknown>).invite_token).toBe(existing.invite_token);
  });
});

// ===========================================================================
// accept: the security-critical refusals
// ===========================================================================

describe("previewInvite", () => {
  it("never touches update - a GET-shaped call must not consume the invite", async () => {
    // Mutant: previewInvite calling the same write path as acceptInvite (a
    // copy/paste mistake) would let a mail-client link scanner silently
    // burn a single-use invite before its intended recipient ever clicks it.
    serviceTable("business_staff").__result = { data: baseStaffRow(), error: null };

    const result = await service.previewInvite("tok_live");

    expect(result.ok).toBe(true);
    expect(serviceTable("business_staff").update).not.toHaveBeenCalled();
  });

  it("reports INVITE_INVALID for an unknown token, same code acceptInvite uses", async () => {
    serviceTable("business_staff").__result = { data: null, error: null };

    const result = await service.previewInvite("nonsense");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("INVITE_INVALID");
  });

  it("reports INVITE_EXPIRED for a past-dated invite", async () => {
    serviceTable("business_staff").__result = {
      data: baseStaffRow({ invite_expires_at: "2020-01-01T00:00:00.000Z" }),
      error: null,
    };

    const result = await service.previewInvite("tok_live");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("INVITE_EXPIRED");
  });

  it("names the inviting business and role for the accept screen to render", async () => {
    const table = serviceTable("business_staff");
    table.select = vi.fn(() => table);
    table.__result = { data: baseStaffRow({ role: "manager" }), error: null };
    serviceTable("businesses").__result = { data: { name: "Kape Diaria" }, error: null };

    const result = await service.previewInvite("tok_live");

    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.businessName).toBe("Kape Diaria");
    expect(result.ok && result.data?.role).toBe("manager");
  });
});

describe("acceptInvite", () => {
  it("an unknown token grants nothing (INVITE_INVALID)", async () => {
    serviceTable("business_staff").__result = { data: null, error: null };

    const result = await service.acceptInvite("nonsense-token", "some-user");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("INVITE_INVALID");
    expect(serviceTable("business_staff").update).not.toHaveBeenCalled();
  });

  it("an already-accepted invite grants nothing again (INVITE_INVALID, not a re-accept)", async () => {
    // Mutant: checking only `row === null` and skipping the status check
    // would let a SECOND accept of an already-`active` row through.
    serviceTable("business_staff").__result = { data: baseStaffRow({ status: "active" }), error: null };

    const result = await service.acceptInvite("tok_live", INVITEE_USER_ID);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("INVITE_INVALID");
    expect(serviceTable("business_staff").update).not.toHaveBeenCalled();
  });

  it("an expired invite does not grant membership (INVITE_EXPIRED)", async () => {
    // Mutant: comparing `invite_expires_at` with the wrong operator (`>`
    // instead of `<`), or never comparing it at all, would accept an expired
    // token. Uses a fixed past date rather than `Date.now() - 1` so a mutant
    // that hardcodes "always in the past" or "always in the future" both fail
    // distinctly from the live-token test below.
    serviceTable("business_staff").__result = {
      data: baseStaffRow({ invite_expires_at: "2020-01-01T00:00:00.000Z" }),
      error: null,
    };

    const result = await service.acceptInvite("tok_live", INVITEE_USER_ID);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("INVITE_EXPIRED");
    expect(serviceTable("business_staff").update).not.toHaveBeenCalled();
  });

  it("with no session, refuses and names who should sign in (SIGN_IN_REQUIRED)", async () => {
    serviceTable("business_staff").__result = { data: baseStaffRow(), error: null };

    const result = await service.acceptInvite("tok_live", null);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("SIGN_IN_REQUIRED");
    expect(serviceTable("business_staff").update).not.toHaveBeenCalled();
  });

  it("signed in as a DIFFERENT account than the invite names: refused, not silently rebound (WRONG_ACCOUNT)", async () => {
    // The brief's headline case. Mutant: dropping this check (or comparing
    // against the wrong field) would let ANY signed-in caller claim ANY
    // invite by guessing/receiving a token meant for someone else's account -
    // the update call proves whether the row was touched at all.
    serviceTable("business_staff").__result = { data: baseStaffRow({ user_id: INVITEE_USER_ID }), error: null };

    const result = await service.acceptInvite("tok_live", "someone-else-entirely");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("WRONG_ACCOUNT");
    expect(serviceTable("business_staff").update).not.toHaveBeenCalled();
  });

  it("the matching account accepts: status flips, token is cleared, single audit row", async () => {
    const row = baseStaffRow();
    const table = serviceTable("business_staff");
    table.select = vi.fn(() => table);
    table.__result = { data: row, error: null };

    const result = await service.acceptInvite("tok_live", INVITEE_USER_ID);

    expect(result.ok).toBe(true);
    const patch = firstCallArg(table, "update");
    expect(patch.status).toBe("active");
    expect(patch.invite_token).toBeNull();
    expect(serviceTable("audit_logs").insert).toHaveBeenCalledTimes(1);
    expect(firstCallArg(serviceTable("audit_logs"), "insert").action).toBe("staff.invite_accepted");
  });

  it("a race that loses the CAS (row changed between read and write) is reported, not silently accepted", async () => {
    const table = serviceTable("business_staff");
    let call = 0;
    table.select = vi.fn(() => table);
    table.maybeSingle = vi.fn(async () => {
      call += 1;
      // First maybeSingle: the read, finds a live invited row.
      // Second maybeSingle: the guarded update, lost the race -> null.
      return call === 1 ? { data: baseStaffRow(), error: null } : { data: null, error: null };
    });

    const result = await service.acceptInvite("tok_live", INVITEE_USER_ID);

    expect(result.ok).toBe(false);
  });

  it("reverts to invited (restoring the token) when the audit write fails", async () => {
    const row = baseStaffRow();
    serviceTable("business_staff").__result = { data: row, error: null };
    serviceTable("audit_logs").insert = vi.fn(() => ({ error: { message: "boom" } }));

    const result = await service.acceptInvite("tok_live", INVITEE_USER_ID);

    expect(result.ok).toBe(false);
    const table = serviceTable("business_staff");
    const calls = (table.update as { mock: { calls: unknown[][] } }).mock.calls;
    const revert = calls[calls.length - 1]?.[0] as Record<string, unknown>;
    expect(revert.status).toBe("invited");
    expect(revert.invite_token).toBe("tok_live");
  });
});

// ===========================================================================
// changeRole
// ===========================================================================

describe("changeRole", () => {
  it("a manager cannot change roles at all (owner-only)", async () => {
    const result = await service.changeRole(BUSINESS, MANAGER_ACTOR, {
      staffId: "staff-row-1",
      role: "marketing",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("NOT_ALLOWED");
  });

  it("refuses to promote a target to owner (NOT_ALLOWED - not an OWNER_REQUIRED case, M13)", async () => {
    // Mutant this catches: using the wrong code here would tell a caller
    // "this would leave zero owners", which is false - there would still be
    // exactly one. Doc 32 reserves OWNER_REQUIRED for that specific
    // invariant; this refusal is "ownership transfer is a different flow".
    const result = await service.changeRole(BUSINESS, OWNER_ACTOR, {
      staffId: "staff-row-1",
      role: "owner",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("NOT_ALLOWED");
    expect(serviceTable("business_staff").update).not.toHaveBeenCalled();
  });

  it("refuses to change the owner row's own role (OWNER_REQUIRED backstop)", async () => {
    serviceTable("business_staff").__result = { data: baseStaffRow({ role: "owner", status: "active" }), error: null };

    const result = await service.changeRole(BUSINESS, OWNER_ACTOR, {
      staffId: "staff-row-1",
      role: "manager",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("OWNER_REQUIRED");
    expect(serviceTable("business_staff").update).not.toHaveBeenCalled();
  });

  it("an owner changing a manager to marketing writes exactly one audit row", async () => {
    const existing = baseStaffRow({ role: "manager", status: "active" });
    const table = serviceTable("business_staff");
    table.select = vi.fn(() => table);
    table.__result = { data: { ...existing, role: "marketing" }, error: null };
    // The read call needs the PRE-change row; simulate distinctly per call.
    let call = 0;
    table.maybeSingle = vi.fn(async () => {
      call += 1;
      return call === 1
        ? { data: existing, error: null }
        : { data: { ...existing, role: "marketing" }, error: null };
    });

    const result = await service.changeRole(BUSINESS, OWNER_ACTOR, {
      staffId: existing.id,
      role: "marketing",
    });

    expect(result.ok).toBe(true);
    expect(serviceTable("audit_logs").insert).toHaveBeenCalledTimes(1);
    const auditRow = firstCallArg(serviceTable("audit_logs"), "insert");
    expect(auditRow.action).toBe("staff.role_changed");
    expect(auditRow.before).toEqual({ role: "manager" });
    expect(auditRow.after).toEqual({ role: "marketing" });
  });
});

// ===========================================================================
// I4 (review fix): the cross-tenant fence. revokeInvite/changeRole run on a
// SERVICE-ROLE client (RLS bypassed), so the `.eq("business_id", ...)` on
// each read is the ENTIRE tenant fence - the subsequent write keys on
// `.eq("id", staffId)` alone. Review found that removing that one predicate
// from either read broke NO existing test (54/54 still passed), because the
// generic `makeBuilder` fake used everywhere else in this file returns the
// same canned `__result` regardless of which `.eq()` calls were actually
// made - it cannot tell a correctly-scoped query from an unscoped one. This
// block uses a builder that actually FILTERS a small in-memory table by
// every `.eq()`/`.neq()` applied to it, so a query missing the business_id
// predicate really does find (and would really mutate) the wrong tenant's
// row - which is exactly what must never happen.
// ===========================================================================

function makeFilteringStaffTable(initialRows: BusinessStaffRowLike[]): FilteringBuilder {
  const rows = initialRows.map((row) => ({ ...row }));
  const builder = {} as FilteringBuilder;
  let filters: Array<[string, unknown, boolean]> = [];
  let pendingPatch: Record<string, unknown> | null = null;
  let isDelete = false;

  // Reset happens on `.from()` (one call per query chain - see
  // `serviceTable()`'s `__reset` hook below), NOT on `.select()`: a real
  // PostgREST chain often calls `.select(cols)` AFTER `.update()`/`.delete()`
  // purely to specify which columns come back, and treating THAT `.select()`
  // as "start a fresh read" would silently drop the pending patch - which is
  // exactly the bug that made this fake report a false positive the first
  // time this test was run (revoke's `.update(...).eq(...).select(...)
  // .maybeSingle()` chain lost its patch at the `.select()` step).
  builder.__reset = () => {
    filters = [];
    pendingPatch = null;
    isDelete = false;
  };
  builder.select = vi.fn(() => builder);
  builder.insert = vi.fn(() => builder);
  builder.update = vi.fn((patch: Record<string, unknown>) => {
    pendingPatch = patch;
    return builder;
  });
  builder.delete = vi.fn(() => {
    isDelete = true;
    return builder;
  });
  builder.eq = vi.fn((key: string, value: unknown) => {
    filters.push([key, value, true]);
    return builder;
  });
  builder.neq = vi.fn((key: string, value: unknown) => {
    filters.push([key, value, false]);
    return builder;
  });
  builder.order = vi.fn(() => builder);
  builder.limit = vi.fn(() => builder);

  function matchIndex(): number {
    return rows.findIndex((row) =>
      filters.every(([key, value, wantEqual]) => {
        const rowValue = (row as Record<string, unknown>)[key];
        return wantEqual ? rowValue === value : rowValue !== value;
      }),
    );
  }

  async function resolve(): Promise<{ data: unknown; error: unknown }> {
    const idx = matchIndex();
    if (idx === -1) return { data: null, error: null };
    if (isDelete) {
      const [removed] = rows.splice(idx, 1);
      return { data: removed ?? null, error: null };
    }
    if (pendingPatch !== null) {
      rows[idx] = { ...rows[idx]!, ...pendingPatch };
    }
    return { data: rows[idx]!, error: null };
  }

  builder.single = vi.fn(resolve);
  builder.maybeSingle = vi.fn(resolve);
  builder.rows = rows;
  return builder;
}

interface BusinessStaffRowLike {
  id: string;
  business_id: string;
  user_id: string;
  role: string;
  status: string;
  invited_email: string | null;
  invite_token: string | null;
  invite_expires_at: string | null;
  created_at: string;
}

interface FilteringBuilder {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  neq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  rows: BusinessStaffRowLike[];
  /** Called once per `.from("business_staff")` - i.e. once per query chain.
   * See the comment above where this is assigned. */
  __reset: () => void;
}

const OTHER_BUSINESS = { id: "biz-OTHER", name: "A Different Shop" };

describe("cross-tenant fence (I4)", () => {
  it("revokeInvite never touches a pending invite that belongs to a DIFFERENT business", async () => {
    // Mutant: dropping `.eq("business_id", business.id)` from revokeInvite's
    // read (service.ts) makes this fail - the filtering table below would
    // then match by id+status alone, find business B's row, and revoke it
    // for a caller who is only owner of business A.
    const rows: BusinessStaffRowLike[] = [
      {
        id: "staff-in-B",
        business_id: OTHER_BUSINESS.id,
        user_id: "someone",
        role: "staff",
        status: "invited",
        invited_email: "x@example.com",
        invite_token: "tok-B",
        invite_expires_at: "2099-01-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    const table = makeFilteringStaffTable(rows);
    serviceBuilders.business_staff = table as unknown as Builder;

    const result = await service.revokeInvite(BUSINESS, OWNER_ACTOR, "staff-in-B");

    expect(result.ok).toBe(false);
    expect(table.rows[0]!.status).toBe("invited");
    expect(table.rows[0]!.invite_token).toBe("tok-B");
  });

  it("changeRole never touches an active member that belongs to a DIFFERENT business", async () => {
    // Mutant: dropping `.eq("business_id", business.id)` from changeRole's
    // read makes this fail the same way.
    const rows: BusinessStaffRowLike[] = [
      {
        id: "staff-in-B",
        business_id: OTHER_BUSINESS.id,
        user_id: "someone",
        role: "manager",
        status: "active",
        invited_email: null,
        invite_token: null,
        invite_expires_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    const table = makeFilteringStaffTable(rows);
    serviceBuilders.business_staff = table as unknown as Builder;

    const result = await service.changeRole(BUSINESS, OWNER_ACTOR, {
      staffId: "staff-in-B",
      role: "marketing",
    });

    expect(result.ok).toBe(false);
    expect(table.rows[0]!.role).toBe("manager");
  });

  it("sanity check: revokeInvite DOES succeed against its own business with the same fixture shape", async () => {
    // Proves the filtering table itself isn't just always refusing - the
    // two tests above fail specifically because of tenant mismatch, not
    // because this fake can never succeed.
    const rows: BusinessStaffRowLike[] = [
      {
        id: "staff-in-A",
        business_id: BUSINESS.id,
        user_id: "someone",
        role: "staff",
        status: "invited",
        invited_email: "x@example.com",
        invite_token: "tok-A",
        invite_expires_at: "2099-01-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    const table = makeFilteringStaffTable(rows);
    serviceBuilders.business_staff = table as unknown as Builder;

    const result = await service.revokeInvite(BUSINESS, OWNER_ACTOR, "staff-in-A");

    expect(result.ok).toBe(true);
    expect(table.rows[0]!.status).toBe("disabled");
    expect(table.rows[0]!.invite_token).toBeNull();
  });
});

// ===========================================================================
// loadRoster: session-scoped read
// ===========================================================================

describe("loadRoster", () => {
  it("reads through the caller's own session, scoped to the business", async () => {
    const table = mocks.makeBuilder();
    table.order = vi.fn(() => Promise.resolve({ data: [baseStaffRow()], error: null }));
    mocks.sessionFrom.mockReturnValue(table);

    const result = await service.loadRoster(BUSINESS.id);

    expect(result.ok).toBe(true);
    expect(table.eq).toHaveBeenCalledWith("business_id", BUSINESS.id);
  });

  it("reports a read failure rather than an empty roster", async () => {
    const table = mocks.makeBuilder();
    table.order = vi.fn(() => Promise.resolve({ data: null, error: { message: "boom" } }));
    mocks.sessionFrom.mockReturnValue(table);

    const result = await service.loadRoster(BUSINESS.id);

    expect(result.ok).toBe(false);
  });
});
