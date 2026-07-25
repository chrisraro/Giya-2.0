import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  const state = {
    user: { id: "user-1" } as { id: string } | null,
    business: { id: "biz-1", slug: "kape-diaria", name: "Kape Diaria", status: "active" } as
      | { id: string; slug: string; name: string; status: string }
      | null,
    profile: { data: null as { display_name: string } | null, error: null as unknown },
    profileFilters: [] as Array<[string, unknown]>,
  };

  function from() {
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn((column: string, value: unknown) => {
      state.profileFilters.push([column, value]);
      return builder;
    });
    builder.maybeSingle = vi.fn(async () => ({ data: state.profile.data, error: state.profile.error }));
    return builder;
  }

  return { state, from: vi.fn(from), getUser: vi.fn(async () => ({ data: { user: state.user } })) };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from })),
}));

vi.mock("./resolve-owner-business", () => ({
  resolveOwnerBusiness: vi.fn(async () => mocks.state.business),
}));

const { initialsOf, resolvePortalContext } = await import("./portal-context");
const { resolveOwnerBusiness } = await import("./resolve-owner-business");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.user = { id: "user-1" };
  mocks.state.business = { id: "biz-1", slug: "kape-diaria", name: "Kape Diaria", status: "active" };
  mocks.state.profile = { data: { display_name: "Karla Mendoza" }, error: null };
  mocks.state.profileFilters = [];
});

describe("resolvePortalContext", () => {
  it("delegates the tenancy answer to the shared resolver instead of asking again", async () => {
    await resolvePortalContext();
    expect(resolveOwnerBusiness).toHaveBeenCalledTimes(1);
    // No second business_staff query of its own.
    expect(mocks.from).toHaveBeenCalledWith("profiles");
    expect(mocks.from).not.toHaveBeenCalledWith("business_staff");
  });

  it("returns the caller's own business and display name", async () => {
    const context = await resolvePortalContext();
    expect(context?.business.name).toBe("Kape Diaria");
    expect(context?.displayName).toBe("Karla Mendoza");
  });

  it("pins the profile read to the signed-in user rather than trusting RLS to leave one row", async () => {
    await resolvePortalContext();
    expect(mocks.state.profileFilters).toContainEqual(["id", "user-1"]);
  });

  it("returns null when the caller has no active membership", async () => {
    mocks.state.business = null;
    expect(await resolvePortalContext()).toBeNull();
  });

  it("returns a null display name rather than a stand-in when the profile is missing", async () => {
    mocks.state.profile = { data: null, error: null };
    const context = await resolvePortalContext();
    expect(context?.displayName).toBeNull();
    expect(context?.business.name).toBe("Kape Diaria");
  });

  it("returns a null display name when the profile read errors", async () => {
    mocks.state.profile = { data: null, error: { message: "boom" } };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const context = await resolvePortalContext();
    expect(context?.displayName).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("initialsOf", () => {
  it("takes the first letter of the first two words", () => {
    expect(initialsOf("Karla Mendoza")).toBe("KM");
    expect(initialsOf("Ramon Dela Cruz")).toBe("RD");
  });

  it("handles a single word", () => {
    expect(initialsOf("Ramon")).toBe("R");
  });

  it("ignores punctuation and extra whitespace", () => {
    expect(initialsOf("  maria-luisa   santos  ")).toBe("MS");
  });

  it("returns null when there is nothing to take an initial from", () => {
    expect(initialsOf(null)).toBeNull();
    expect(initialsOf("   ")).toBeNull();
    expect(initialsOf("...")).toBeNull();
  });

  it("works on a non-latin script rather than dropping it", () => {
    expect(initialsOf("陳 大文")).toBe("陳大");
  });
});
