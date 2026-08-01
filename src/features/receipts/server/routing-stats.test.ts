// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

// Same three stubs every service-role suite in this codebase uses: the module
// is `server-only`, it reads the env at import time, and its default deps mint
// a real service-role client. Every test below injects its own.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { ROUTING_WINDOW_DAYS, loadRoutingBreakdown } from "./routing-stats";
import type { RoutingStatsDeps } from "./routing-stats";

// D10's one read. The arithmetic is ../routing-breakdown.test.ts's; what is
// asserted here is the part that cannot be tested purely and that a mistake in
// would be a cross-tenant leak wearing a percentage sign: WHICH arguments reach
// the RPC, and that a failed read never renders as a healthy zero.

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

function createDeps(result: {
  data?: Array<{ kind: string; key: string; tally: number }>;
  error?: { message: string } | null;
}): { deps: RoutingStatsDeps; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const supabase = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({
        data: result.data ?? [],
        error: result.error ?? null,
      });
    },
  } as unknown as SupabaseClient<Database>;
  return { deps: { supabase }, calls };
}

describe("loadRoutingBreakdown", () => {
  it("scopes to the business it was given, which is the entire tenancy fence", async () => {
    // The client is the SERVICE ROLE and bypasses RLS, so this argument is not
    // defence in depth: it IS the fence. Its only legitimate source is
    // resolveReviewerContext().
    const { deps, calls } = createDeps({});

    await loadRoutingBreakdown({ businessId: "biz-1" }, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("receipt_routing_breakdown");
    expect(calls[0]?.args.p_business_id).toBe("biz-1");
  });

  it("omits the business argument entirely for the platform call", async () => {
    // Passing an explicit null would work, but omitting it lets the function's
    // own `default null` be the single definition of "the whole platform".
    const { deps, calls } = createDeps({});

    await loadRoutingBreakdown({ businessId: null }, deps);

    expect(calls[0]?.args).not.toHaveProperty("p_business_id");
  });

  it("asks for the shared window, so the two portals cannot compare periods", async () => {
    const { deps, calls } = createDeps({});

    await loadRoutingBreakdown({ businessId: "biz-1" }, deps);

    expect(calls[0]?.args.p_days).toBe(ROUTING_WINDOW_DAYS);
    expect(ROUTING_WINDOW_DAYS).toBe(30);
  });

  it("folds the rows it is given", async () => {
    const { deps } = createDeps({
      data: [
        { kind: "status", key: "approved", tally: 9 },
        { kind: "status", key: "review", tally: 1 },
        { kind: "reason", key: "staff_self_scan", tally: 1 },
      ],
    });

    const breakdown = await loadRoutingBreakdown({ businessId: "biz-1" }, deps);

    expect(breakdown?.total).toBe(10);
    expect(breakdown?.reviewRate).toBeCloseTo(0.1);
    expect(breakdown?.reasons[0]?.key).toBe("staff_self_scan");
    expect(breakdown?.windowDays).toBe(30);
  });

  it("CRITICAL: a failed read is null, never a reassuring 0%", async () => {
    const { deps } = createDeps({ error: { message: "connection reset" } });

    expect(await loadRoutingBreakdown({ businessId: "biz-1" }, deps)).toBeNull();
  });

  it("treats an empty result as a real answer, not as a failure", async () => {
    // A business with no receipts in the window. Zeros are a legitimate answer
    // and the panel renders its own empty state off `total === 0`.
    const { deps } = createDeps({ data: [] });

    const breakdown = await loadRoutingBreakdown({ businessId: "biz-1" }, deps);

    expect(breakdown).not.toBeNull();
    expect(breakdown?.total).toBe(0);
  });

  it("returns null rather than throwing when the service role is not configured", async () => {
    expect(await loadRoutingBreakdown({ businessId: "biz-1" }, null)).toBeNull();
  });

  it("honours an explicit window override", async () => {
    const { deps, calls } = createDeps({});

    const breakdown = await loadRoutingBreakdown(
      { businessId: "biz-1", windowDays: 7 },
      deps,
    );

    expect(calls[0]?.args.p_days).toBe(7);
    expect(breakdown?.windowDays).toBe(7);
  });
});
