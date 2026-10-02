import { beforeEach, describe, expect, it, vi } from "vitest";

// Doc 01's matrix: `support` is read-only everywhere. Purging is the most
// destructive action on the platform, so it is super_admin only; the go-live
// decisions follow the consequence ladder (admin or super_admin). These are
// the action-layer guards; 0081 re-checks the purge in SQL.

const mocks = vi.hoisted(() => ({
  resolveAdminContext: vi.fn(),
  activateBusiness: vi.fn(),
  rejectBusinessVerification: vi.fn(),
  purgeBusiness: vi.fn(),
  purgeAllBusinesses: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Fully mocked: the real module pulls the Supabase server client and env.
// canActOnLadder mirrors access.ts's one-line predicate (tested there).
vi.mock("./access", () => ({
  resolveAdminContext: mocks.resolveAdminContext,
  canActOnLadder: (role: string) => role === "super_admin" || role === "admin",
}));
vi.mock("./business-decisions", () => ({
  activateBusiness: mocks.activateBusiness,
  rejectBusinessVerification: mocks.rejectBusinessVerification,
  purgeBusiness: mocks.purgeBusiness,
  purgeAllBusinesses: mocks.purgeAllBusinesses,
}));

import {
  approveBusinessAction,
  deleteBusinessAction,
  purgeAllBusinessesAction,
  sendBusinessBackAction,
} from "./business-actions";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const decision = { businessId: BUSINESS_ID, reason: "Duplicate listing" };

function signInAs(role: "super_admin" | "admin" | "support") {
  mocks.resolveAdminContext.mockResolvedValue({ userId: "admin-1", displayName: "A", role });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [
    mocks.activateBusiness,
    mocks.rejectBusinessVerification,
    mocks.purgeBusiness,
    mocks.purgeAllBusinesses,
  ]) {
    fn.mockResolvedValue({ ok: true });
  }
});

describe("purge actions are super_admin only", () => {
  it.each(["admin", "support"] as const)("refuses a single-business purge for %s", async (role) => {
    signInAs(role);
    const result = await deleteBusinessAction(decision);
    expect(result).toMatchObject({ ok: false, code: "NOT_ALLOWED" });
    expect(mocks.purgeBusiness).not.toHaveBeenCalled();
  });

  it.each(["admin", "support"] as const)("refuses purge-all for %s", async (role) => {
    signInAs(role);
    const result = await purgeAllBusinessesAction({ reason: "reset" });
    expect(result).toMatchObject({ ok: false, code: "NOT_ALLOWED" });
    expect(mocks.purgeAllBusinesses).not.toHaveBeenCalled();
  });

  it("lets a super_admin purge, passing the session's own id as the actor", async () => {
    signInAs("super_admin");
    await expect(deleteBusinessAction(decision)).resolves.toMatchObject({ ok: true });
    expect(mocks.purgeBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, actorId: "admin-1" }),
    );
  });
});

describe("go-live decisions follow the consequence ladder", () => {
  it.each([
    ["approve", approveBusinessAction, mocks.activateBusiness],
    ["send back", sendBusinessBackAction, mocks.rejectBusinessVerification],
  ] as const)("refuses %s for read-only support", async (_label, action, decide) => {
    signInAs("support");
    await expect(action(decision)).resolves.toMatchObject({ ok: false, code: "NOT_ALLOWED" });
    expect(decide).not.toHaveBeenCalled();
  });

  it.each(["admin", "super_admin"] as const)("lets %s approve", async (role) => {
    signInAs(role);
    await expect(approveBusinessAction(decision)).resolves.toMatchObject({ ok: true });
  });
});

it("refuses everything without an admin session", async () => {
  mocks.resolveAdminContext.mockResolvedValue(null);
  await expect(deleteBusinessAction(decision)).resolves.toMatchObject({ ok: false, code: "NOT_ALLOWED" });
});
