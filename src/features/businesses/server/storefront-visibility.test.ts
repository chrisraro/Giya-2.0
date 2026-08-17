import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// THE APPROVAL BOUNDARY (G1 section 4).
//
// G1 deliberately lets a business that nobody has approved yet use the whole
// business portal: it registers as `draft`, walks straight into
// /business/dashboard, and fills itself in with a profile, a menu, promos and
// rewards while it waits for review. The thing that must NOT happen is any of
// that reaching a consumer. `status = 'active'` in public-repo.ts is the
// control that holds that line, and it went from "sensible filter" to
// "load-bearing" the moment the portal stopped waiting for approval.
//
// WHY THIS FILE EXISTS SEPARATELY FROM public-repo.test.ts.
//
// That suite's fake query builder ignores its own filters and hands back
// whatever `__result` was seeded, so its status assertions are of the form
// "`.eq` was called with ('status','active')". That kills a mutant that deletes
// the line, which is worth something, but it cannot tell a filter that WORKS
// from a filter that is merely PRESENT - `.eq("status", "active")` on the wrong
// builder, or applied after a `.or()`, would still satisfy it.
//
// The double below actually filters. Rows are seeded with real statuses and the
// repo has to exclude them itself, so what is asserted is the outcome a
// consumer would see rather than the shape of the call.
//
// The three consumer surfaces named in the brief all read through exactly the
// two functions pinned here:
//   /discover               -> listActiveBusinesses  (discover/page.tsx:21)
//   /home                   -> listActiveBusinesses  (home/page.tsx:35)
//   /b/[slug]               -> getBusinessBySlug     (b/[slug]/page.tsx:32,51)
// and so do /scan and /wallet/[businessId], which are covered for free.
// ===========================================================================

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

/**
 * An in-memory stand-in for one PostgREST table that HONOURS the filters it is
 * given. Only the operators public-repo.ts actually uses are implemented, and
 * an unimplemented one would be a missing method rather than a silent no-op.
 */
interface FakeTable {
  select(): FakeTable;
  eq(column: string, value: unknown): FakeTable;
  in(column: string, values: readonly unknown[]): FakeTable;
  is(column: string, value: unknown): FakeTable;
  ilike(column: string, pattern: string): FakeTable;
  order(column: string, options?: { ascending?: boolean }): FakeTable;
  limit(count: number): FakeTable;
  maybeSingle(): Promise<{ data: Row | null; error: null }>;
  then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown): Promise<unknown>;
}

function makeTable(seed: readonly Row[]): FakeTable {
  let rows: Row[] = [...seed];
  // `order` and `limit` are RECORDED, not applied, and are replayed only when
  // the builder is awaited. PostgREST orders and limits the whole filtered set
  // server-side, so a double that applied them the moment they were chained
  // would truncate rows before a later `.in()`/`.ilike()` ever saw them.
  // listActiveBusinesses chains exactly that way - `.limit()` first, `.in()`
  // afterwards - and an eager `limit(1)` made two of the assertions below pass
  // against a repo with NO status filter at all, because the one row that
  // survived the truncation happened to be the approved one.
  let ordering: { column: string; ascending: boolean } | null = null;
  let take: number | null = null;

  function resolveRows(): Row[] {
    let resolved = [...rows];
    if (ordering !== null) {
      const { column, ascending } = ordering;
      resolved.sort(
        (a, b) => String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1),
      );
    }
    if (take !== null) resolved = resolved.slice(0, take);
    return resolved;
  }

  const table: FakeTable = {
    select: () => table,
    eq(column, value) {
      rows = rows.filter((row) => row[column] === value);
      return table;
    },
    in(column, values) {
      rows = rows.filter((row) => values.includes(row[column]));
      return table;
    },
    is(column, value) {
      rows = rows.filter((row) => (row[column] ?? null) === value);
      return table;
    },
    ilike(column, pattern) {
      const needle = pattern.replaceAll("%", "").toLowerCase();
      rows = rows.filter((row) => String(row[column] ?? "").toLowerCase().includes(needle));
      return table;
    },
    order(column, { ascending = true }: { ascending?: boolean } = {}) {
      ordering = { column, ascending };
      return table;
    },
    limit(count) {
      take = count;
      return table;
    },
    async maybeSingle() {
      return { data: resolveRows()[0] ?? null, error: null };
    },
    then(resolve, reject) {
      return Promise.resolve({ data: resolveRows(), error: null }).then(resolve, reject);
    },
  };

  return table;
}

const mocks = vi.hoisted(() => ({ tables: {} as Record<string, readonly Row[]> }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (name: string) => makeTable(mocks.tables[name] ?? []),
  }),
}));

const repo = await import("./public-repo");

const CITY = { id: "city-1", name: "Cebu City" };
const TYPE = { id: "type-1", name: "Cafe" };

/**
 * One row per live `businesses_status_check` value, so the fixture is the whole
 * state machine rather than the two statuses this brief happens to name.
 * Transcribed from the constraint, not imported from the app.
 */
function businessRow(status: string): Row {
  return {
    id: `biz-${status}`,
    slug: `shop-${status.replaceAll("_", "-")}`,
    name: `Shop ${status}`,
    description: null,
    logo_url: null,
    cover_url: null,
    opening_hours: null,
    city_id: CITY.id,
    business_type_id: TYPE.id,
    address_line: null,
    barangay: null,
    postal_code: null,
    lat: null,
    lng: null,
    deleted_at: null,
  };
}

const ALL_STATUSES = ["draft", "pending_verification", "active", "suspended", "closed"] as const;

/** The two a merchant sits in while it is building itself out inside the portal. */
const UNAPPROVED_STATUSES = ["draft", "pending_verification"] as const;

beforeEach(() => {
  mocks.tables = {
    businesses: ALL_STATUSES.map((status) => ({ ...businessRow(status), status })),
    ref_cities: [CITY],
    ref_business_types: [TYPE],
  };
});

describe("listActiveBusinesses - the /discover and /home rail (G1 section 4)", () => {
  it("CRITICAL: returns only the approved business out of all five statuses", async () => {
    const result = await repo.listActiveBusinesses({ limit: 50 });

    expect(result.map((business) => business.slug)).toEqual(["shop-active"]);
  });

  for (const status of UNAPPROVED_STATUSES) {
    it(`CRITICAL: a ${status} business is absent from the list a consumer browses`, async () => {
      const result = await repo.listActiveBusinesses({ limit: 50 });

      expect(result.some((business) => business.name === `Shop ${status}`)).toBe(false);
    });

    it(`CRITICAL: a ${status} business cannot be surfaced by searching for it by name`, async () => {
      // The search path is the one that feels safest and is not: a consumer who
      // types the exact name of a shop that just registered must still find
      // nothing, or the filter is decorative on the browse path only.
      const result = await repo.listActiveBusinesses({ query: `Shop ${status}`, limit: 50 });

      expect(result).toEqual([]);
    });

    it(`CRITICAL: a ${status} business cannot be surfaced by asking for its id directly`, async () => {
      // /scan?business={id} and /wallet/[businessId] both resolve a business by
      // id through this function. An id is guessable from a QR code a merchant
      // printed before approval, so the id path needs the filter as much as the
      // browse path does.
      const result = await repo.listActiveBusinesses({ ids: [`biz-${status}`], limit: 1 });

      expect(result).toEqual([]);
    });
  }

  it("still returns the approved business when it is asked for by id", async () => {
    // The negative cases above would all pass against a repo that returned
    // nothing at all. This is the one that says the filter is a filter and not
    // a wall.
    const result = await repo.listActiveBusinesses({ ids: ["biz-active"], limit: 1 });

    expect(result.map((business) => business.slug)).toEqual(["shop-active"]);
  });

  it("excludes a soft-deleted approved business", async () => {
    mocks.tables.businesses = [
      { ...businessRow("active"), status: "active", deleted_at: "2026-01-01T00:00:00Z" },
    ];

    expect(await repo.listActiveBusinesses({ limit: 50 })).toEqual([]);
  });
});

describe("getBusinessBySlug - the /b/[slug] storefront (G1 section 4)", () => {
  for (const status of UNAPPROVED_STATUSES) {
    it(`CRITICAL: a ${status} business is unreachable at its own slug`, async () => {
      const result = await repo.getBusinessBySlug(`shop-${status.replaceAll("_", "-")}`);

      // The page turns null into notFound(), so null here IS the 404 a consumer
      // who was handed the link would get.
      expect(result).toBeNull();
    });
  }

  it("serves the approved business at its slug", async () => {
    const result = await repo.getBusinessBySlug("shop-active");

    expect(result?.name).toBe("Shop active");
  });

  it("is unreachable for a suspended or closed business too", async () => {
    expect(await repo.getBusinessBySlug("shop-suspended")).toBeNull();
    expect(await repo.getBusinessBySlug("shop-closed")).toBeNull();
  });
});
