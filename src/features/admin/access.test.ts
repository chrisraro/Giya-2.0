// The gate every admin surface stands on.
//
// WHAT THIS SUITE IS FOR. `resolveAdminContext` is not one fence among several:
// nothing downstream of it applies a tenancy predicate, because the admin
// surfaces are platform-wide by design. So the assertions below are about the
// exact set of conditions under which it hands back an identity, and every
// other condition returning null.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  const state = {
    user: { id: "admin-1" } as { id: string } | null,
    admin: { data: null as { user_id: string; role: string; is_active: boolean } | null, error: null as unknown },
    profile: { data: null as { id: string; display_name: string } | null, error: null as unknown },
    calls: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
  };

  function from(table: string) {
    const record = { table, filters: [] as Array<[string, unknown]> };
    state.calls.push(record);
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn((column: string, value: unknown) => {
      record.filters.push([column, value]);
      return builder;
    });
    builder.maybeSingle = vi.fn(async () =>
      table === "platform_admins"
        ? { data: state.admin.data, error: state.admin.error }
        : { data: state.profile.data, error: state.profile.error },
    );
    return builder;
  }

  return { state, from: vi.fn(from), getUser: vi.fn(async () => ({ data: { user: state.user } })) };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from })),
}));

const { canActOnLadder, resolveAdminContext } = await import("./access");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.user = { id: "admin-1" };
  mocks.state.admin = { data: { user_id: "admin-1", role: "admin", is_active: true }, error: null };
  mocks.state.profile = { data: { id: "admin-1", display_name: "Ops Lead" }, error: null };
  mocks.state.calls = [];
});

describe("resolveAdminContext", () => {
  it("returns the caller's admin identity when they hold an active platform_admins row", async () => {
    const admin = await resolveAdminContext();
    expect(admin).toEqual({ userId: "admin-1", displayName: "Ops Lead", role: "admin" });
  });

  it("reads the admin row by TABLE TRUTH, pinned to the caller's own id and to is_active", async () => {
    await resolveAdminContext();
    const call = mocks.state.calls.find((entry) => entry.table === "platform_admins");
    // The predicate is not left to the RLS policy alone. Doc 12 requires a
    // server-side table check for destructive permissions, and this is it.
    expect(call?.filters).toContainEqual(["user_id", "admin-1"]);
    expect(call?.filters).toContainEqual(["is_active", true]);
  });

  it("returns null when there is no session", async () => {
    mocks.state.user = null;
    expect(await resolveAdminContext()).toBeNull();
  });

  it("returns null when the caller has no platform_admins row", async () => {
    mocks.state.admin = { data: null, error: null };
    expect(await resolveAdminContext()).toBeNull();
  });

  it("fails CLOSED when the admin read errors", async () => {
    // A membership read that errored proves nothing, and guessing here means an
    // unauthenticated admin portal.
    mocks.state.admin = { data: null, error: { message: "connection reset" } };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await resolveAdminContext()).toBeNull();
    spy.mockRestore();
  });

  it("returns null for a role the schema does not recognise", async () => {
    // A row whose role drifted outside 0002's check constraint is not a licence
    // to guess at what authority it means.
    mocks.state.admin = { data: { user_id: "admin-1", role: "root", is_active: true }, error: null };
    expect(await resolveAdminContext()).toBeNull();
  });

  it("still resolves when the profile row is missing, with a neutral name", async () => {
    // The identity that matters is the admin row. A missing display name is a
    // cosmetic gap and must not lock an operator out mid-incident.
    mocks.state.profile = { data: null, error: null };
    const admin = await resolveAdminContext();
    expect(admin?.userId).toBe("admin-1");
    expect(admin?.displayName).toBe("Admin");
  });
});

describe("canActOnLadder", () => {
  it("permits super_admin and admin", () => {
    expect(canActOnLadder("super_admin")).toBe(true);
    expect(canActOnLadder("admin")).toBe(true);
  });

  it("refuses support, which doc 01's matrix makes read-only everywhere", () => {
    expect(canActOnLadder("support")).toBe(false);
  });
});
