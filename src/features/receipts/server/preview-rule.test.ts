import { beforeEach, describe, expect, it, vi } from "vitest";

// The read behind the /scan estimate. It exists so the figure a consumer sees
// is computed under THEIR shop's rule rather than the preview action's
// 1-point-per-peso fallback, so the things worth pinning are all about refusing
// to answer: no service-role key, no rule, a half-configured rule, and a rule
// this control cannot honestly preview.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ createServiceRoleClient: vi.fn() }));

vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

const { loadScanPreviewRule } = await import("./preview-rule");

const BUSINESS_ID = "3f1b0d9c-4444-4444-8444-444444444444";

type Filter = { readonly column: string; readonly value: unknown };

/** A stand-in for the one chained PostgREST query this module builds. */
function serviceClient(result: { data: unknown; error: unknown }) {
  const filters: Filter[] = [];
  const builder: Record<string, unknown> = {};
  builder.eq = vi.fn((column: string, value: unknown) => {
    filters.push({ column, value });
    return builder;
  });
  builder.is = vi.fn((column: string, value: unknown) => {
    filters.push({ column, value });
    return builder;
  });
  builder.maybeSingle = vi.fn().mockResolvedValue(result);

  const select = vi.fn().mockReturnValue(builder);
  const from = vi.fn().mockReturnValue({ select });

  return { client: { from }, filters, from, select };
}

function filterFor(filters: readonly Filter[], column: string): unknown {
  return filters.find((filter) => filter.column === column)?.value;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadScanPreviewRule", () => {
  it("returns the shop's rate and rounding mode", async () => {
    mocks.createServiceRoleClient.mockReturnValue(
      serviceClient({ data: { rate_centavos_per_point: 5000, rounding: "ceil" }, error: null })
        .client,
    );

    await expect(loadScanPreviewRule(BUSINESS_ID)).resolves.toEqual({
      rateCentavosPerPoint: 5000,
      rounding: "ceil",
    });
  });

  it("CRITICAL: asks only for this shop's active, undeleted, amount-rate base rule", async () => {
    const stub = serviceClient({ data: null, error: null });
    mocks.createServiceRoleClient.mockReturnValue(stub.client);

    await loadScanPreviewRule(BUSINESS_ID);

    expect(stub.from).toHaveBeenCalledWith("points_rules");
    expect(filterFor(stub.filters, "business_id")).toBe(BUSINESS_ID);
    expect(filterFor(stub.filters, "kind")).toBe("base");
    // fixed_per_visit and fixed_per_receipt award the same points whatever the
    // receipt says. Previewing one through a peso field would be a control that
    // cannot change its own output.
    expect(filterFor(stub.filters, "rule_type")).toBe("amount_rate");
    expect(filterFor(stub.filters, "is_active")).toBe(true);
    expect(filterFor(stub.filters, "deleted_at")).toBeNull();
  });

  it("CRITICAL: throws on a query error rather than degrading to a made-up rate", async () => {
    mocks.createServiceRoleClient.mockReturnValue(
      serviceClient({ data: null, error: { message: "permission denied for table points_rules" } })
        .client,
    );

    // Returning null here would be indistinguishable from "this shop has no
    // rule", which is a normal state /scan handles by showing no estimate. The
    // caller catches; this read does not decide for it.
    await expect(loadScanPreviewRule(BUSINESS_ID)).rejects.toThrow(
      /loadScanPreviewRule: failed to load the base earning rule: permission denied/,
    );
  });

  it("returns null when the shop has no base rule at all", async () => {
    mocks.createServiceRoleClient.mockReturnValue(
      serviceClient({ data: null, error: null }).client,
    );

    await expect(loadScanPreviewRule(BUSINESS_ID)).resolves.toBeNull();
  });

  it("returns null for a half-configured rule whose rate is still empty", async () => {
    mocks.createServiceRoleClient.mockReturnValue(
      serviceClient({ data: { rate_centavos_per_point: null, rounding: "floor" }, error: null })
        .client,
    );

    await expect(loadScanPreviewRule(BUSINESS_ID)).resolves.toBeNull();
  });

  it("returns null for a zero rate rather than dividing by it", async () => {
    mocks.createServiceRoleClient.mockReturnValue(
      serviceClient({ data: { rate_centavos_per_point: 0, rounding: "floor" }, error: null })
        .client,
    );

    await expect(loadScanPreviewRule(BUSINESS_ID)).resolves.toBeNull();
  });

  it("returns null, and reads nothing, when no service-role key is configured", async () => {
    // The documented degraded path of createServiceRoleClient: credentials
    // arrive at the end of a build, and a missing one means no estimate rather
    // than a broken /scan.
    mocks.createServiceRoleClient.mockReturnValue(null);

    await expect(loadScanPreviewRule(BUSINESS_ID)).resolves.toBeNull();
  });
});
