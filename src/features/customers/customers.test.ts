import { describe, it, expect, vi, beforeEach } from "vitest";

// Query-builder fake, same shape as src/features/campaigns/campaigns.test.ts.
const mocks = vi.hoisted(() => {
  function makeBuilder() {
    const builder: Record<string, unknown> = {
      __result: { data: null, error: null } as { data: unknown; error: unknown },
    };
    for (const method of ["select", "insert", "update", "delete", "eq", "in", "is", "order", "limit"]) {
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
    from: vi.fn(),
    auditInsert: vi.fn(),
    serviceClient: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  })),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: mocks.serviceClient,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const actions = await import("./actions");
const { CUSTOMER_VIEW_ROLES, CUSTOMER_WRITE_ROLES } = await import("./roles");
const repo = await import("./server/repo");
const service = await import("./server/service");
const { revalidatePath } = await import("next/cache");

type Builder = ReturnType<typeof mocks.makeBuilder>;

const AUTH_USER = { id: "user-1" };
const OWN_BUSINESS = "biz-1";
const OTHER_BUSINESS = "biz-2";
const CUSTOMER_ID = "44444444-4444-4444-8444-444444444444";
const CONSUMER_ID = "4f2a1111-1111-4111-8111-111111111111";

const BUSINESS_ROW = { id: OWN_BUSINESS, slug: "kape-diaria", name: "Kape Diaria", status: "active" };

function customerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    business_id: OWN_BUSINESS,
    consumer_id: CONSUMER_ID,
    segment: "regular",
    points_balance: 250,
    lifetime_points: 900,
    lifetime_spend_centavos: 125_00,
    visit_count: 12,
    first_visit_at: "2026-01-01T00:00:00.000Z",
    last_visit_at: "2026-07-20T00:00:00.000Z",
    notes: null,
    ...overrides,
  };
}

let builders: Record<string, Builder>;

/**
 * The fake builder stores its methods as `unknown`, so reading a recorded call
 * argument needs one narrowing step. Kept in a helper so the assertions below
 * stay about the patch, not about the mock's typing.
 */
function firstCallArg(builder: Builder, method: string): Record<string, unknown> {
  const fn = builder[method] as { mock: { calls: unknown[][] } };
  return (fn.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
}

function table(name: string): Builder {
  const b = builders[name];
  if (!b) throw new Error(`no mock builder registered for table "${name}"`);
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();

  builders = {
    business_staff: mocks.makeBuilder(),
    businesses: mocks.makeBuilder(),
    business_customers: mocks.makeBuilder(),
  };
  table("business_staff").__result = { data: { business_id: OWN_BUSINESS, role: "owner" }, error: null };
  table("businesses").__result = { data: BUSINESS_ROW, error: null };
  table("business_customers").__result = { data: customerRow(), error: null };

  mocks.from.mockImplementation((name: string) => table(name));
  mocks.getUser.mockResolvedValue({ data: { user: AUTH_USER } });

  mocks.auditInsert.mockResolvedValue({ error: null });
  mocks.serviceClient.mockReturnValue({ from: vi.fn(() => ({ insert: mocks.auditInsert })) });
});

// ===========================================================================
// THE COLUMN FENCE (migration 0013: update granted on segment, notes,
// updated_by only)
// ===========================================================================

describe("the business_customers column grant", () => {
  it("names exactly the three columns 0013 grants", () => {
    expect(repo.GRANTED_UPDATE_COLUMNS).toEqual(["segment", "notes", "updated_by"]);
  });

  it.each(["points_balance", "lifetime_points", "visit_count", "lifetime_spend_centavos", "business_id"])(
    "refuses a patch that names %s before it can reach Postgres",
    (column) => {
      expect(() => repo.assertGrantedColumns({ segment: "vip", [column]: 1 })).toThrow(column);
    },
  );

  it("accepts a patch made only of granted columns", () => {
    expect(() =>
      repo.assertGrantedColumns({ segment: "vip", notes: "regular", updated_by: "user-1" }),
    ).not.toThrow();
  });

  it("a segment change writes segment and updated_by, and nothing else", async () => {
    table("business_customers").maybeSingle = vi.fn(async () => ({ data: customerRow(), error: null }));
    table("business_customers").single = vi.fn(async () => ({
      data: customerRow({ segment: "vip" }),
      error: null,
    }));

    const result = await actions.changeCustomerSegment({ customerId: CUSTOMER_ID, segment: "vip" });

    expect(result.ok).toBe(true);
    const patch = firstCallArg(table("business_customers"), "update");
    expect(Object.keys(patch).sort()).toEqual(["segment", "updated_by"]);
    expect(patch.segment).toBe("vip");
    expect(patch.updated_by).toBe(AUTH_USER.id);
  });

  it("a note change writes notes and updated_by, and nothing else", async () => {
    table("business_customers").single = vi.fn(async () => ({
      data: customerRow({ notes: "Always orders oat milk" }),
      error: null,
    }));

    const result = await actions.updateCustomerNotes({
      customerId: CUSTOMER_ID,
      notes: "Always orders oat milk",
    });

    expect(result.ok).toBe(true);
    const patch = firstCallArg(table("business_customers"), "update");
    expect(Object.keys(patch).sort()).toEqual(["notes", "updated_by"]);
  });

  it("an empty note is stored as null rather than an empty string", async () => {
    table("business_customers").single = vi.fn(async () => ({ data: customerRow(), error: null }));

    await actions.updateCustomerNotes({ customerId: CUSTOMER_ID, notes: "   " });

    const patch = firstCallArg(table("business_customers"), "update");
    expect(patch.notes).toBeNull();
  });
});

// ------------------------------------------------------------- role gating

describe("actions: role gating", () => {
  it("refuses a caller with no session", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    const result = await actions.changeCustomerSegment({ customerId: CUSTOMER_ID, segment: "vip" });

    expect(result.ok).toBe(false);
    expect(table("business_customers").update).not.toHaveBeenCalled();
  });

  it("asks for owner/manager only on the write path, not the three view roles", async () => {
    table("business_customers").maybeSingle = vi.fn(async () => ({ data: customerRow(), error: null }));
    table("business_customers").single = vi.fn(async () => ({ data: customerRow(), error: null }));

    await actions.changeCustomerSegment({ customerId: CUSTOMER_ID, segment: "vip" });

    expect(table("business_staff").in).toHaveBeenCalledWith("role", ["owner", "manager"]);
    expect(CUSTOMER_WRITE_ROLES).toEqual(["owner", "manager"]);
    expect(CUSTOMER_VIEW_ROLES).toEqual(["owner", "manager", "marketing"]);
  });

  it("refuses a marketing member, whose membership row the role filter excludes", async () => {
    table("business_staff").__result = { data: null, error: null };

    const result = await actions.changeCustomerSegment({ customerId: CUSTOMER_ID, segment: "vip" });

    expect(result.ok).toBe(false);
    expect(table("business_customers").update).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------- tenancy

describe("tenancy", () => {
  it("reads the list scoped to the business resolved from business_staff", async () => {
    table("business_customers").__result = { data: [customerRow()], error: null };

    await service.loadCustomers(OWN_BUSINESS, { segment: "all", sort: "last_visit" });

    expect(table("business_customers").eq).toHaveBeenCalledWith("business_id", OWN_BUSINESS);
    expect(table("business_customers").eq).not.toHaveBeenCalledWith("business_id", OTHER_BUSINESS);
  });

  it("scopes every write by id AND business_id", async () => {
    table("business_customers").maybeSingle = vi.fn(async () => ({ data: customerRow(), error: null }));
    table("business_customers").single = vi.fn(async () => ({ data: customerRow(), error: null }));

    await actions.changeCustomerSegment({ customerId: CUSTOMER_ID, segment: "vip" });

    expect(table("business_customers").eq).toHaveBeenCalledWith("id", CUSTOMER_ID);
    expect(table("business_customers").eq).toHaveBeenCalledWith("business_id", OWN_BUSINESS);
  });

  it("ignores a business id smuggled in with the payload", async () => {
    table("business_customers").maybeSingle = vi.fn(async () => ({ data: customerRow(), error: null }));
    table("business_customers").single = vi.fn(async () => ({ data: customerRow(), error: null }));

    await actions.changeCustomerSegment({
      customerId: CUSTOMER_ID,
      segment: "vip",
      businessId: OTHER_BUSINESS,
    });

    expect(table("business_customers").eq).not.toHaveBeenCalledWith("business_id", OTHER_BUSINESS);
  });

  it("refuses a customer id that does not resolve inside the caller's tenant", async () => {
    table("business_customers").maybeSingle = vi.fn(async () => ({ data: null, error: null }));

    const result = await actions.changeCustomerSegment({
      customerId: CUSTOMER_ID,
      segment: "blacklisted",
      reason: "Repeated fake receipts",
    });

    expect(result).toEqual({ ok: false, message: "That customer is not one of yours." });
    expect(table("business_customers").update).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------- segmenting

describe("segment changes", () => {
  beforeEach(() => {
    table("business_customers").maybeSingle = vi.fn(async () => ({ data: customerRow(), error: null }));
    table("business_customers").single = vi.fn(async () => ({
      data: customerRow({ segment: "blacklisted" }),
      error: null,
    }));
  });

  it("requires a typed reason before blocking someone", async () => {
    const result = await actions.changeCustomerSegment({
      customerId: CUSTOMER_ID,
      segment: "blacklisted",
    });

    expect(result.ok).toBe(false);
    expect(table("business_customers").update).not.toHaveBeenCalled();
  });

  it("does not require a reason to promote someone to VIP", async () => {
    table("business_customers").single = vi.fn(async () => ({
      data: customerRow({ segment: "vip" }),
      error: null,
    }));

    const result = await actions.changeCustomerSegment({ customerId: CUSTOMER_ID, segment: "vip" });

    expect(result.ok).toBe(true);
  });

  it("writes a customer.segment_changed audit row carrying the reason and the before/after", async () => {
    await actions.changeCustomerSegment({
      customerId: CUSTOMER_ID,
      segment: "blacklisted",
      reason: "Repeated fake receipts",
    });

    expect(mocks.auditInsert).toHaveBeenCalledTimes(1);
    const row = mocks.auditInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.action).toBe("customer.segment_changed");
    expect(row.entity_type).toBe("business_customer");
    expect(row.entity_id).toBe(CUSTOMER_ID);
    expect(row.business_id).toBe(OWN_BUSINESS);
    expect(row.actor_id).toBe(AUTH_USER.id);
    expect(row.actor_kind).toBe("user");
    expect(row.actor_role).toBe("owner");
    expect(row.reason).toBe("Repeated fake receipts");
    expect(row.before).toEqual({ segment: "regular" });
    expect(row.after).toEqual({ segment: "blacklisted" });
  });

  it("puts no customer data beyond the segment in the audit diff", async () => {
    await actions.changeCustomerSegment({
      customerId: CUSTOMER_ID,
      segment: "blacklisted",
      reason: "Repeated fake receipts",
    });

    const row = mocks.auditInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(row.before as object)).toEqual(["segment"]);
    expect(Object.keys(row.after as object)).toEqual(["segment"]);
  });

  it("is a no-op when the segment is already what was asked for", async () => {
    const result = await actions.changeCustomerSegment({
      customerId: CUSTOMER_ID,
      segment: "regular",
    });

    expect(result.ok).toBe(true);
    expect(table("business_customers").update).not.toHaveBeenCalled();
    expect(mocks.auditInsert).not.toHaveBeenCalled();
  });

  it("still applies the change when no service-role key is configured, and says nothing broke", async () => {
    mocks.serviceClient.mockReturnValue(null);

    const result = await actions.changeCustomerSegment({
      customerId: CUSTOMER_ID,
      segment: "blacklisted",
      reason: "Repeated fake receipts",
    });

    expect(result.ok).toBe(true);
    expect(table("business_customers").update).toHaveBeenCalled();
  });

  it("reports loudly when the audit insert itself fails, after the change is already applied", async () => {
    mocks.auditInsert.mockResolvedValue({ error: { message: "denied" } });

    const result = await actions.changeCustomerSegment({
      customerId: CUSTOMER_ID,
      segment: "blacklisted",
      reason: "Repeated fake receipts",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("activity log");
    expect(table("business_customers").update).toHaveBeenCalled();
  });

  it("revalidates the customers route on success", async () => {
    table("business_customers").single = vi.fn(async () => ({
      data: customerRow({ segment: "vip" }),
      error: null,
    }));

    await actions.changeCustomerSegment({ customerId: CUSTOMER_ID, segment: "vip" });

    expect(revalidatePath).toHaveBeenCalledWith("/business/customers");
  });
});

// -------------------------------------------------------------------- list

describe("loadCustomers", () => {
  it("reports a read failure rather than an empty CRM", async () => {
    table("business_customers").__result = { data: null, error: { message: "boom" } };

    const result = await service.loadCustomers(OWN_BUSINESS, { segment: "all", sort: "last_visit" });

    expect(result.ok).toBe(false);
  });

  it("distinguishes a business with no customers from a failed read", async () => {
    table("business_customers").__result = { data: [], error: null };

    const result = await service.loadCustomers(OWN_BUSINESS, { segment: "all", sort: "last_visit" });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.customers).toEqual([]);
    expect(result.ok && result.data?.truncated).toBe(false);
  });

  it("maps each named sort onto a real column, never onto the raw parameter", async () => {
    table("business_customers").__result = { data: [], error: null };

    await service.loadCustomers(OWN_BUSINESS, { segment: "all", sort: "spend" });

    expect(table("business_customers").order).toHaveBeenCalledWith("lifetime_spend_centavos", {
      ascending: false,
      nullsFirst: false,
    });
  });

  it("applies a segment filter only when one was chosen", async () => {
    table("business_customers").__result = { data: [], error: null };

    await service.loadCustomers(OWN_BUSINESS, { segment: "all", sort: "last_visit" });
    expect(table("business_customers").eq).not.toHaveBeenCalledWith("segment", "all");

    await service.loadCustomers(OWN_BUSINESS, { segment: "blacklisted", sort: "last_visit" });
    expect(table("business_customers").eq).toHaveBeenCalledWith("segment", "blacklisted");
  });

  it("shapes rows with the real columns the CRM shows", async () => {
    table("business_customers").__result = { data: [customerRow()], error: null };

    const result = await service.loadCustomers(OWN_BUSINESS, { segment: "all", sort: "last_visit" });

    expect(result.ok && result.data?.customers[0]).toEqual({
      id: CUSTOMER_ID,
      consumerId: CONSUMER_ID,
      reference: "4F2A",
      segment: "regular",
      pointsBalance: 250,
      lifetimePoints: 900,
      lifetimeSpendCentavos: 12500,
      visitCount: 12,
      firstVisitAt: "2026-01-01T00:00:00.000Z",
      lastVisitAt: "2026-07-20T00:00:00.000Z",
      notes: null,
    });
  });

  it("falls back to 'regular' for a segment value outside the three the check constraint allows", async () => {
    table("business_customers").__result = { data: [customerRow({ segment: "platinum" })], error: null };

    const result = await service.loadCustomers(OWN_BUSINESS, { segment: "all", sort: "last_visit" });

    expect(result.ok && result.data?.customers[0]?.segment).toBe("regular");
  });
});

describe("customerReference", () => {
  it("is a short, stable handle derived from the consumer id", () => {
    expect(service.customerReference(CONSUMER_ID)).toBe("4F2A");
    expect(service.customerReference(CONSUMER_ID)).toBe(service.customerReference(CONSUMER_ID));
  });
});
