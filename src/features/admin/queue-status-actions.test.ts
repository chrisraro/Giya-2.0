// @vitest-environment node
//
// The `/admin/monitoring/queues` server action: the FIRST fence a caller with
// no session or no `platform_admins` row meets, before `replayJob`'s own
// table-truth check (tested in `jobs.test.ts`) ever runs. This is the "assert
// the refusal, not just the absence of a link" test the brief asks for, at
// the layer a business user or an unauthenticated caller would actually hit.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  resolveAdminContext: vi.fn(),
  replayJob: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("./access", () => ({ resolveAdminContext: mocks.resolveAdminContext }));
vi.mock("./jobs", () => ({ replayJob: mocks.replayJob }));

const { replayJobAction } = await import("./queue-status-actions");

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const REASON = "confirmed the upstream fix; safe to retry";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("replayJobAction", () => {
  // Mutant: drop the `admin === null` early return (or call `replayJob`
  // unconditionally). Proves a caller with no session - or a business user,
  // for whom `resolveAdminContext()` returns the identical `null` - is
  // refused BEFORE the privileged write is ever attempted, not merely that
  // no button is rendered for them.
  it("refuses a caller with no admin session, without ever calling replayJob", async () => {
    mocks.resolveAdminContext.mockResolvedValue(null);

    const result = await replayJobAction({ jobId: JOB_ID, reason: REASON });

    expect(result).toEqual({ ok: false, code: "NOT_ALLOWED", message: expect.any(String) });
    expect(mocks.replayJob).not.toHaveBeenCalled();
  });

  it("rejects malformed input before calling replayJob", async () => {
    mocks.resolveAdminContext.mockResolvedValue({
      userId: "admin-1",
      displayName: "Ops Lead",
      role: "admin",
    });

    const result = await replayJobAction({ jobId: "not-a-uuid", reason: REASON });

    expect(result).toEqual({ ok: false, code: "INVALID_INPUT", message: expect.any(String) });
    expect(mocks.replayJob).not.toHaveBeenCalled();
  });

  it("resolves the actor from the session, never from client input", async () => {
    mocks.resolveAdminContext.mockResolvedValue({
      userId: "admin-1",
      displayName: "Ops Lead",
      role: "admin",
    });
    mocks.replayJob.mockResolvedValue({
      ok: true,
      detail: { status: "queued", attempts: 0, republished: true },
    });

    // A hostile or buggy client naming a DIFFERENT actor id is ignored: the
    // schema has no `actorId` field at all, so there is nothing to trust.
    await replayJobAction({ jobId: JOB_ID, reason: REASON, actorId: "someone-else" });

    expect(mocks.replayJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID, reason: REASON, actorId: "admin-1" }),
    );
  });

  it("revalidates the queues path on success", async () => {
    mocks.resolveAdminContext.mockResolvedValue({
      userId: "admin-1",
      displayName: "Ops Lead",
      role: "admin",
    });
    mocks.replayJob.mockResolvedValue({
      ok: true,
      detail: { status: "queued", attempts: 0, republished: false },
    });

    const result = await replayJobAction({ jobId: JOB_ID, reason: REASON });

    expect(result.ok).toBe(true);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin/monitoring/queues");
  });

  it("passes a typed failure straight through without revalidating", async () => {
    mocks.resolveAdminContext.mockResolvedValue({
      userId: "admin-1",
      displayName: "Ops Lead",
      role: "admin",
    });
    mocks.replayJob.mockResolvedValue({
      ok: false,
      code: "INVALID_STATE",
      message: "Only dead jobs can be replayed.",
    });

    const result = await replayJobAction({ jobId: JOB_ID, reason: REASON });

    expect(result).toEqual({
      ok: false,
      code: "INVALID_STATE",
      message: "Only dead jobs can be replayed.",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
