// Public-seam tests for the server actions: session -> resolveStaffContext ->
// service, exactly as settings.test.ts / customers.test.ts test their own
// actions.ts. Deliberately goes through the REAL service.ts (not a mock of
// it) against a faked Supabase client, so a wiring bug between actions.ts and
// service.ts (wrong argument order, a swallowed error) would show up here
// even though service.test.ts already covers service.ts's own logic in
// isolation.

import { describe, it, expect, vi, beforeEach } from "vitest";

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
    schemaFrom: vi.fn(),
    schema: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.sessionFrom,
  })),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: mocks.serviceClient,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./server/notify", () => ({ sendStaffInviteEmail: vi.fn(async () => undefined) }));

const actions = await import("./actions");
const { revalidatePath } = await import("next/cache");

type Builder = ReturnType<typeof mocks.makeBuilder>;

const AUTH_USER = { id: "owner-1" };
const OWN_BUSINESS = "biz-1";

function membershipRow(overrides: Record<string, unknown> = {}) {
  return { business_id: OWN_BUSINESS, role: "owner", ...overrides };
}

function businessRow() {
  return { id: OWN_BUSINESS, slug: "kape-diaria", name: "Kape Diaria", status: "active" };
}

let sessionBuilders: Record<string, Builder>;
let serviceBuilders: Record<string, Builder>;

function sessionTable(name: string): Builder {
  const b = sessionBuilders[name];
  if (!b) throw new Error(`no session mock builder registered for table "${name}"`);
  return b;
}

function serviceTable(name: string): Builder {
  const b = serviceBuilders[name];
  if (!b) throw new Error(`no service-role mock builder registered for table "${name}"`);
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();

  sessionBuilders = { business_staff: mocks.makeBuilder(), businesses: mocks.makeBuilder() };
  sessionTable("business_staff").__result = { data: membershipRow(), error: null };
  sessionTable("businesses").__result = { data: businessRow(), error: null };
  mocks.sessionFrom.mockImplementation((name: string) => sessionBuilders[name]);
  mocks.getUser.mockResolvedValue({ data: { user: AUTH_USER } });

  serviceBuilders = { business_staff: mocks.makeBuilder(), audit_logs: mocks.makeBuilder() };
  serviceTable("business_staff").__result = {
    data: {
      id: "staff-row-1",
      business_id: OWN_BUSINESS,
      user_id: "invitee-1",
      role: "staff",
      status: "invited",
      invited_email: "new@example.com",
      invite_token: "tok",
      invite_expires_at: "2099-01-01T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
    },
    error: null,
  };
  serviceTable("audit_logs").insert = vi.fn(() => ({ error: null }));
  mocks.serviceFrom.mockImplementation((name: string) => serviceBuilders[name]);

  // `findExistingAuthUser` (round-3 review fix): defaults to "no existing
  // row", matching every test below, all written expecting the
  // generateLink/account-creation path.
  const authUsers = mocks.makeBuilder();
  authUsers.__result = { data: null, error: null };
  mocks.schemaFrom.mockReturnValue(authUsers);
  mocks.schema.mockReturnValue({ from: mocks.schemaFrom });

  mocks.serviceClient.mockReturnValue({
    from: mocks.serviceFrom,
    auth: { admin: { generateLink: mocks.generateLink } },
    schema: mocks.schema,
  });
  mocks.generateLink.mockResolvedValue({
    data: { user: { id: "invitee-1" }, properties: { action_link: null } },
    error: null,
  });
});

describe("inviteStaffAction: role gating at the action layer", () => {
  it("refuses a staff-role caller outright - the action never reaches the service write", async () => {
    sessionTable("business_staff").__result = { data: null, error: null }; // .in(role,[owner,manager]) excludes staff

    const result = await actions.inviteStaffAction({ email: "new@example.com", role: "staff" });

    expect(result.ok).toBe(false);
    expect(serviceTable("business_staff").insert).not.toHaveBeenCalled();
  });

  it("refuses a caller with no session at all", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    const result = await actions.inviteStaffAction({ email: "new@example.com", role: "staff" });

    expect(result.ok).toBe(false);
    expect(serviceTable("business_staff").insert).not.toHaveBeenCalled();
  });

  it("an owner's invite reaches the service, writes the row, and revalidates /business/staff", async () => {
    serviceTable("business_staff").__result = {
      data: {
        id: "staff-row-1",
        business_id: OWN_BUSINESS,
        user_id: "invitee-1",
        role: "staff",
        status: "invited",
        invited_email: "new@example.com",
        invite_token: "tok",
        invite_expires_at: "2099-01-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      error: null,
    };

    const result = await actions.inviteStaffAction({ email: "new@example.com", role: "staff" });

    expect(result.ok).toBe(true);
    expect(serviceTable("business_staff").insert).toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/business/staff");
  });

  it("rejects a malformed email before it ever reaches the service (no membership query wasted)", async () => {
    const result = await actions.inviteStaffAction({ email: "not-an-email", role: "staff" });

    expect(result.ok).toBe(false);
    expect(serviceTable("business_staff").insert).not.toHaveBeenCalled();
  });

  it("asks the database for owner and manager only - the roster gate's own predicate", async () => {
    await actions.inviteStaffAction({ email: "new@example.com", role: "staff" });

    expect(sessionTable("business_staff").in).toHaveBeenCalledWith("role", ["owner", "manager"]);
  });
});

describe("acceptInviteAction: threads the CURRENT session, never a client-supplied id", () => {
  it("with no session, the service sees null - not a forged identity", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    serviceTable("business_staff").__result = {
      data: {
        id: "row-1",
        business_id: OWN_BUSINESS,
        user_id: "invitee-1",
        role: "staff",
        status: "invited",
        invited_email: "invitee@example.com",
        invite_token: "tok_live",
        invite_expires_at: "2099-01-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      error: null,
    };

    const result = await actions.acceptInviteAction("tok_live");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("SIGN_IN_REQUIRED");
  });

  it("a signed-in caller whose id matches the invite's user_id accepts", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "invitee-1" } } });
    const table = serviceTable("business_staff");
    table.select = vi.fn(() => table);
    table.__result = {
      data: {
        id: "row-1",
        business_id: OWN_BUSINESS,
        user_id: "invitee-1",
        role: "staff",
        status: "invited",
        invited_email: "invitee@example.com",
        invite_token: "tok_live",
        invite_expires_at: "2099-01-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      error: null,
    };

    const result = await actions.acceptInviteAction("tok_live");

    expect(result.ok).toBe(true);
  });

  it("rejects a non-string/empty token before ever touching the database", async () => {
    const result = await actions.acceptInviteAction("");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("INVITE_INVALID");
    expect(serviceTable("business_staff").select).not.toHaveBeenCalled();
  });
});
