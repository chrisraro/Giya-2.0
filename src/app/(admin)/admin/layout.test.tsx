import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ===========================================================================
// THE GATE ON `/admin`.
//
// One property, tested from several angles: a caller who is not an active
// platform admin gets a 404, and the portal does not render for them.
//
// WHY 404 AND NOT "FORBIDDEN". A redirect or a permission page answers a
// question the caller did not ask, and the answer is "this route exists and you
// are not on the list" - the first sentence of a targeted attack. `notFound()`
// makes `/admin` indistinguishable from `/adminn` for everyone who is not an
// admin, which is the whole point of the assertions below.
//
// The gate is in the LAYOUT rather than in middleware because doc 12 makes
// claims a hint and the table the truth: `is_platform_admin` in a JWT is up to
// an hour stale, and the actions behind this layout are suspension and
// clawback.
// ===========================================================================

const mocks = vi.hoisted(() => ({
  resolveAdminContext: vi.fn(),
  notFound: vi.fn(() => {
    // Next's own `notFound()` throws to unwind the render. Matching that here is
    // what makes "the layout does not render its children" testable at all: a
    // mock that returned undefined would let the tree carry on rendering, which
    // is precisely the failure mode being guarded against.
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  usePathname: () => "/admin",
}));

vi.mock("@/features/admin/access", () => ({
  resolveAdminContext: mocks.resolveAdminContext,
}));

vi.mock("@/features/identity/actions", () => ({
  signOut: vi.fn(),
}));

const AdminLayout = (await import("./layout")).default;

function Child() {
  return <p>PLATFORM ADMINISTRATION CONTENT</p>;
}

async function renderLayout() {
  const tree = await AdminLayout({ children: <Child /> });
  render(tree);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the /admin gate", () => {
  it("404s a signed-in user who is not a platform admin", async () => {
    mocks.resolveAdminContext.mockResolvedValue(null);
    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });

  it("404s an unauthenticated caller through the same path, with no separate branch", async () => {
    // `resolveAdminContext` returns null for "no session" and for "not an
    // admin" identically, so nothing here can tell the two apart - and neither
    // can anyone probing the route.
    mocks.resolveAdminContext.mockResolvedValue(null);
    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders NOTHING of the portal for a non-admin, not even the chrome", async () => {
    mocks.resolveAdminContext.mockResolvedValue(null);
    await expect(renderLayout()).rejects.toThrow();
    expect(screen.queryByText("PLATFORM ADMINISTRATION CONTENT")).toBeNull();
    expect(screen.queryByText("Platform administration")).toBeNull();
  });

  it("does not redirect, so nothing tells a non-admin the route exists", async () => {
    mocks.resolveAdminContext.mockResolvedValue(null);
    await expect(renderLayout()).rejects.toThrow();
    // If a `redirect` ever appears in this layout, this assertion is the thing
    // that should stop it.
    expect(mocks.notFound).toHaveBeenCalled();
  });

  it("renders the portal for an active admin, with their name and role", async () => {
    mocks.resolveAdminContext.mockResolvedValue({
      userId: "admin-1",
      displayName: "Ops Lead",
      role: "super_admin",
    });

    await renderLayout();

    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(screen.getByText("PLATFORM ADMINISTRATION CONTENT")).toBeInTheDocument();
    expect(screen.getByText("Ops Lead")).toBeInTheDocument();
    expect(screen.getByText("super admin")).toBeInTheDocument();
  });

  it("says once, in the chrome, that everything here is recorded", async () => {
    // Doc 31 §11's reason-required pattern works because operators know it is
    // standing policy, not a warning about one action.
    mocks.resolveAdminContext.mockResolvedValue({
      userId: "admin-1",
      displayName: "Ops Lead",
      role: "admin",
    });
    await renderLayout();
    expect(
      screen.getByText(/recorded against your name, with the reason you give/i),
    ).toBeInTheDocument();
  });
});
