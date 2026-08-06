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
  return b;
}

function firstCallArg(builder: Builder, method: string): Record<string, unknown> {
  const fn = builder[method] as { mock: { calls: unknown[][] } };
  return (fn.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
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
    expect(result.ok || (result as { code?: string }).code).not.toBe(true);
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

  it("maps a unique-violation (23505) to INVITE_DUPLICATE, not a generic failure", async () => {
    // Mutant: forgetting the `error.code === "23505"` branch (or checking the
    // wrong code) would fall through to the generic message and lose the
    // caller-facing code doc 32 registers for this case.
    serviceTable("business_staff").__result = {
      data: null,
      error: { code: "23505", message: "duplicate key" },
    };

    const result = await service.inviteStaff(BUSINESS, OWNER_ACTOR, {
      email: "existing@example.com",
      role: "staff",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("INVITE_DUPLICATE");
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

  it("refuses to promote a target to owner (OWNER_REQUIRED backstop)", async () => {
    const result = await service.changeRole(BUSINESS, OWNER_ACTOR, {
      staffId: "staff-row-1",
      role: "owner",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("OWNER_REQUIRED");
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
