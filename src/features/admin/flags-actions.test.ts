// @vitest-environment node
//
// The `/admin/flags` server action: the FIRST fence a caller with no session
// or no `platform_admins` row meets, before `toggleFeatureFlag`'s own
// table-truth super_admin check (tested in `flags.test.ts`) ever runs. This
// is the "assert the refusal, not just the absence of a link" test the brief
// asks for, at the layer a business user or an unauthenticated caller would
// actually hit.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  resolveAdminContext: vi.fn(),
  toggleFeatureFlag: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("./access", () => ({ resolveAdminContext: mocks.resolveAdminContext }));
vi.mock("./flags", () => ({ toggleFeatureFlag: mocks.toggleFeatureFlag }));

const { toggleFeatureFlagAction } = await import("./flags-actions");

const REASON = "operator asked us to pause parse-assist during a Groq incident";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toggleFeatureFlagAction", () => {
  // Mutant: drop the `admin === null` early return (or call
  // `toggleFeatureFlag` unconditionally). Proves a caller with no session -
  // or a signed-in but non-admin user, for whom `resolveAdminContext()`
  // returns the identical `null` - is refused BEFORE the privileged write is
  // ever attempted, not merely that no switch is rendered for them.
  it("refuses a caller with no admin session, without ever calling toggleFeatureFlag", async () => {
    mocks.resolveAdminContext.mockResolvedValue(null);

    const result = await toggleFeatureFlagAction({
      key: "ai_parse_assist",
      isEnabled: false,
      reason: REASON,
    });

    expect(result).toEqual({ ok: false, code: "NOT_ALLOWED", message: expect.any(String) });
    expect(mocks.toggleFeatureFlag).not.toHaveBeenCalled();
  });

  it("rejects malformed input before calling toggleFeatureFlag", async () => {
    mocks.resolveAdminContext.mockResolvedValue({
      userId: "admin-1",
      displayName: "Ops Lead",
      role: "super_admin",
    });

    const result = await toggleFeatureFlagAction({ key: "", isEnabled: false, reason: REASON });

    expect(result).toEqual({ ok: false, code: "INVALID_INPUT", message: expect.any(String) });
    expect(mocks.toggleFeatureFlag).not.toHaveBeenCalled();
  });

  it("resolves the actor from the session, never from client input", async () => {
    mocks.resolveAdminContext.mockResolvedValue({
      userId: "admin-1",
      displayName: "Ops Lead",
      role: "super_admin",
    });
    mocks.toggleFeatureFlag.mockResolvedValue({
      ok: true,
      item: { key: "ai_parse_assist", description: "x", isEnabled: false, updatedAt: "now" },
    });

    // A hostile or buggy client naming a DIFFERENT actor id is ignored: the
    // schema has no `actorId` field at all, so there is nothing to trust.
    await toggleFeatureFlagAction({
      key: "ai_parse_assist",
      isEnabled: false,
      reason: REASON,
      actorId: "someone-else",
    });

    expect(mocks.toggleFeatureFlag).toHaveBeenCalledWith(
      expect.objectContaining({ key: "ai_parse_assist", isEnabled: false, actorId: "admin-1" }),
    );
  });

  it("revalidates the flags path on success", async () => {
    mocks.resolveAdminContext.mockResolvedValue({
      userId: "admin-1",
      displayName: "Ops Lead",
      role: "super_admin",
    });
    mocks.toggleFeatureFlag.mockResolvedValue({
      ok: true,
      item: { key: "ai_parse_assist", description: "x", isEnabled: false, updatedAt: "now" },
    });

    const result = await toggleFeatureFlagAction({
      key: "ai_parse_assist",
      isEnabled: false,
      reason: REASON,
    });

    expect(result.ok).toBe(true);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin/flags");
  });

  it("passes a typed failure straight through without revalidating", async () => {
    mocks.resolveAdminContext.mockResolvedValue({
      userId: "admin-1",
      displayName: "Ops Lead",
      role: "super_admin",
    });
    mocks.toggleFeatureFlag.mockResolvedValue({
      ok: false,
      code: "FORBIDDEN",
      message: "Only a super admin can change a feature flag.",
    });

    const result = await toggleFeatureFlagAction({
      key: "ai_parse_assist",
      isEnabled: false,
      reason: REASON,
    });

    expect(result).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "Only a super admin can change a feature flag.",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
