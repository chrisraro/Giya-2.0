import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import { purgeAllBusinesses, purgeBusiness } from "./business-decisions";

// The purge used to fall back, on ANY RPC error, to force_delete_business
// (which deleted the tenant's audit_logs and wrote no audit row) and then to
// ~17 non-transactional table deletes with their errors ignored. A failed
// purge must now stay failed: one audited RPC, or nothing.

function depsWith(rpcError: { message: string } | null) {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: rpcError });
  const from = vi.fn();
  return { rpc, from, deps: { supabase: { rpc, from } as never } };
}

// Reasons must clear presenter.ts's MIN_REASON_LENGTH (8), or the call stops
// at REASON_REQUIRED before reaching the path under test.
const input = { businessId: "b-1", actorId: "admin-1", reason: "Duplicate listing", requestId: "r-1" };
const ALL = { actorId: "admin-1", reason: "Clearing pre-launch test data" };

describe("purgeBusiness", () => {
  it("calls only purge_business and succeeds", async () => {
    const { rpc, from, deps } = depsWith(null);
    await expect(purgeBusiness(input, deps)).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("purge_business", {
      p_business_id: "b-1",
      p_actor_id: "admin-1",
      p_reason: "Duplicate listing",
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("on RPC failure neither falls back to force_delete_business nor deletes table by table", async () => {
    const { rpc, from, deps } = depsWith({ message: "boom" });
    await expect(purgeBusiness(input, deps)).resolves.toMatchObject({ ok: false, code: "WRITE_FAILED" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });

  it("maps the SQL super_admin check to FORBIDDEN", async () => {
    const { deps } = depsWith({ message: "PURGE_FORBIDDEN" });
    await expect(purgeBusiness(input, deps)).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

describe("purgeAllBusinesses", () => {
  it("on RPC failure deletes nothing directly", async () => {
    const { rpc, from, deps } = depsWith({ message: "boom" });
    await expect(purgeAllBusinesses(ALL, deps)).resolves.toMatchObject({
      ok: false,
      code: "WRITE_FAILED",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });

  it("maps PURGE_FORBIDDEN to FORBIDDEN", async () => {
    const { deps } = depsWith({ message: "PURGE_FORBIDDEN" });
    await expect(purgeAllBusinesses(ALL, deps)).resolves.toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
  });
});
