import { describe, it, expect, beforeEach, vi } from "vitest";

// Same fake query-builder shape as src/features/menu/menu.test.ts, extended
// with `.in()` since public-repo.ts filters variants/addons by a list of
// visible product ids.
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

  return { makeBuilder, from: vi.fn() };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: mocks.from })),
}));

const repo = await import("./public-repo");

type Builder = ReturnType<typeof mocks.makeBuilder>;

let builders: Record<string, Builder>;

function table(name: string): Builder {
  const b = builders[name];
  if (!b) throw new Error(`no mock builder registered for table "${name}"`);
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();

  builders = {
    businesses: mocks.makeBuilder(),
    ref_cities: mocks.makeBuilder(),
    ref_business_types: mocks.makeBuilder(),
    menu_categories: mocks.makeBuilder(),
    products: mocks.makeBuilder(),
    product_variants: mocks.makeBuilder(),
    product_addons: mocks.makeBuilder(),
  };
  mocks.from.mockImplementation((name: string) => table(name));
});

describe("getBusinessBySlug", () => {
  const BUSINESS_ROW = {
    id: "biz-1",
    slug: "kape-diaria",
    name: "Kape Diaria",
    description: "Third-wave coffee.",
    logo_url: "https://cdn.giya.ph/logo.png",
    cover_url: "https://cdn.giya.ph/cover.png",
    opening_hours: [{ day: 1, open: "08:00", close: "20:00" }],
    city_id: "city-1",
    business_type_id: "type-1",
    address_line: "12 Real Street",
    barangay: "San Jose",
    postal_code: "5000",
    lat: 10.3156,
    lng: 123.8854,
  };

  it("returns null when no active, non-deleted business matches the slug", async () => {
    table("businesses").__result = { data: null, error: null };

    const result = await repo.getBusinessBySlug("does-not-exist");

    expect(result).toBeNull();
    expect(table("ref_cities").select).not.toHaveBeenCalled();
  });

  it("filters by slug, active status, and not-deleted", async () => {
    table("businesses").__result = { data: BUSINESS_ROW, error: null };
    table("ref_cities").__result = { data: { name: "Cebu City" }, error: null };
    table("ref_business_types").__result = { data: { name: "Cafe" }, error: null };

    await repo.getBusinessBySlug("kape-diaria");

    expect(table("businesses").eq).toHaveBeenCalledWith("slug", "kape-diaria");
    expect(table("businesses").eq).toHaveBeenCalledWith("status", "active");
    expect(table("businesses").is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("shapes the business row and resolves city/business-type names", async () => {
    table("businesses").__result = { data: BUSINESS_ROW, error: null };
    table("ref_cities").__result = { data: { name: "Cebu City" }, error: null };
    table("ref_business_types").__result = { data: { name: "Cafe" }, error: null };

    const result = await repo.getBusinessBySlug("kape-diaria");

    expect(result).toEqual({
      id: "biz-1",
      slug: "kape-diaria",
      name: "Kape Diaria",
      description: "Third-wave coffee.",
      logoUrl: "https://cdn.giya.ph/logo.png",
      coverUrl: "https://cdn.giya.ph/cover.png",
      openingHours: [{ day: 1, open: "08:00", close: "20:00" }],
      cityName: "Cebu City",
      businessTypeName: "Cafe",
      addressText: "12 Real Street, San Jose, Cebu City, 5000",
      coordinates: { lat: 10.3156, lng: 123.8854 },
    });
    expect(table("ref_cities").eq).toHaveBeenCalledWith("id", "city-1");
    expect(table("ref_business_types").eq).toHaveBeenCalledWith("id", "type-1");
  });

  // ------------------------------------------------------------- the map pin

  it("reads no pin at all when only one of lat/lng is stored", async () => {
    table("businesses").__result = { data: { ...BUSINESS_ROW, lng: null }, error: null };
    table("ref_cities").__result = { data: { name: "Cebu City" }, error: null };
    table("ref_business_types").__result = { data: { name: "Cafe" }, error: null };

    const result = await repo.getBusinessBySlug("kape-diaria");

    // Half a pair would centre a map on the Atlantic with total confidence.
    expect(result?.coordinates).toBeNull();
  });

  it("reads no pin when a stored coordinate is out of range", async () => {
    table("businesses").__result = { data: { ...BUSINESS_ROW, lat: 910 }, error: null };
    table("ref_cities").__result = { data: { name: "Cebu City" }, error: null };
    table("ref_business_types").__result = { data: { name: "Cafe" }, error: null };

    const result = await repo.getBusinessBySlug("kape-diaria");

    expect(result?.coordinates).toBeNull();
  });

  it("assembles the address without leaving gaps for the parts that are blank", async () => {
    table("businesses").__result = {
      data: { ...BUSINESS_ROW, barangay: null, postal_code: "  " },
      error: null,
    };
    table("ref_cities").__result = { data: { name: "Cebu City" }, error: null };
    table("ref_business_types").__result = { data: { name: "Cafe" }, error: null };

    const result = await repo.getBusinessBySlug("kape-diaria");

    expect(result?.addressText).toBe("12 Real Street, Cebu City");
  });

  it("reports no address at all rather than an empty string when every part is blank", async () => {
    table("businesses").__result = {
      data: { ...BUSINESS_ROW, address_line: null, barangay: null, postal_code: null, city_id: null },
      error: null,
    };
    table("ref_business_types").__result = { data: { name: "Cafe" }, error: null };

    const result = await repo.getBusinessBySlug("kape-diaria");

    // The page omits the whole "Where to find us" block on null; an empty
    // string would give it a heading with nothing under it.
    expect(result?.addressText).toBeNull();
  });

  it("resolves cityName to null when the business has no city_id", async () => {
    table("businesses").__result = { data: { ...BUSINESS_ROW, city_id: null }, error: null };
    table("ref_business_types").__result = { data: { name: "Cafe" }, error: null };

    const result = await repo.getBusinessBySlug("kape-diaria");

    expect(result?.cityName).toBeNull();
    expect(table("ref_cities").select).not.toHaveBeenCalled();
  });
});

describe("getPublicMenu", () => {
  it("returns an empty array when there are no active categories", async () => {
    table("menu_categories").__result = { data: [], error: null };
    table("products").__result = { data: [], error: null };

    const result = await repo.getPublicMenu("biz-1");

    expect(result).toEqual([]);
  });

  it("filters categories by business, is_active, and not-deleted, ordered by sort", async () => {
    table("menu_categories").__result = { data: [], error: null };
    table("products").__result = { data: [], error: null };

    await repo.getPublicMenu("biz-1");

    expect(table("menu_categories").eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(table("menu_categories").eq).toHaveBeenCalledWith("is_active", true);
    expect(table("menu_categories").is).toHaveBeenCalledWith("deleted_at", null);
    expect(table("menu_categories").order).toHaveBeenCalledWith("sort", { ascending: true });
  });

  it("filters products by business, status in (active, sold_out), and not-deleted", async () => {
    table("menu_categories").__result = { data: [], error: null };
    table("products").__result = { data: [], error: null };

    await repo.getPublicMenu("biz-1");

    expect(table("products").eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(table("products").in).toHaveBeenCalledWith("status", ["active", "sold_out"]);
    expect(table("products").is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("nests each category's products, and each product's available variants/add-ons", async () => {
    table("menu_categories").__result = {
      data: [{ id: "cat-1", name: "Drinks", description: null }],
      error: null,
    };
    table("products").__result = {
      data: [
        {
          id: "prod-1",
          name: "Iced Latte",
          description: "Cold brew latte",
          base_price_centavos: 12000,
          status: "active",
          category_id: "cat-1",
        },
      ],
      error: null,
    };
    table("product_variants").__result = {
      data: [{ id: "var-1", name: "Large", price_centavos: 15000, product_id: "prod-1" }],
      error: null,
    };
    table("product_addons").__result = {
      data: [{ id: "add-1", name: "Extra shot", price_delta_centavos: 3000, product_id: "prod-1" }],
      error: null,
    };

    const result = await repo.getPublicMenu("biz-1");

    expect(result).toEqual([
      {
        category: { id: "cat-1", name: "Drinks", description: null },
        products: [
          {
            id: "prod-1",
            name: "Iced Latte",
            description: "Cold brew latte",
            basePriceCentavos: 12000,
            status: "active",
            variants: [{ id: "var-1", name: "Large", priceCentavos: 15000 }],
            addons: [{ id: "add-1", name: "Extra shot", priceDeltaCentavos: 3000 }],
          },
        ],
      },
    ]);
    expect(table("product_variants").in).toHaveBeenCalledWith("product_id", ["prod-1"]);
    expect(table("product_variants").eq).toHaveBeenCalledWith("is_available", true);
    expect(table("product_addons").in).toHaveBeenCalledWith("product_id", ["prod-1"]);
    expect(table("product_addons").eq).toHaveBeenCalledWith("is_available", true);
  });

  it("does not query variants/add-ons when there are no visible products", async () => {
    table("menu_categories").__result = {
      data: [{ id: "cat-1", name: "Drinks", description: null }],
      error: null,
    };
    table("products").__result = { data: [], error: null };

    const result = await repo.getPublicMenu("biz-1");

    expect(result).toEqual([
      { category: { id: "cat-1", name: "Drinks", description: null }, products: [] },
    ]);
    expect(table("product_variants").select).not.toHaveBeenCalled();
    expect(table("product_addons").select).not.toHaveBeenCalled();
  });

  it("leaves a category's products empty when none belong to it", async () => {
    table("menu_categories").__result = {
      data: [
        { id: "cat-1", name: "Drinks", description: null },
        { id: "cat-2", name: "Snacks", description: null },
      ],
      error: null,
    };
    table("products").__result = {
      data: [
        {
          id: "prod-1",
          name: "Iced Latte",
          description: null,
          base_price_centavos: 12000,
          status: "active",
          category_id: "cat-1",
        },
      ],
      error: null,
    };
    table("product_variants").__result = { data: [], error: null };
    table("product_addons").__result = { data: [], error: null };

    const result = await repo.getPublicMenu("biz-1");

    expect(result.find((g) => g.category?.id === "cat-2")?.products).toEqual([]);
  });

  it("groups visible products with no category_id into a trailing group with category: null", async () => {
    table("menu_categories").__result = {
      data: [{ id: "cat-1", name: "Drinks", description: null }],
      error: null,
    };
    table("products").__result = {
      data: [
        {
          id: "prod-1",
          name: "Iced Latte",
          description: null,
          base_price_centavos: 12000,
          status: "active",
          category_id: "cat-1",
        },
        {
          id: "prod-2",
          name: "Loose Chips",
          description: null,
          base_price_centavos: 5000,
          status: "active",
          category_id: null,
        },
      ],
      error: null,
    };
    table("product_variants").__result = { data: [], error: null };
    table("product_addons").__result = { data: [], error: null };

    const result = await repo.getPublicMenu("biz-1");

    expect(result).toHaveLength(2);
    expect(result[0]?.category?.id).toBe("cat-1");
    expect(result[1]).toEqual({
      category: null,
      products: [
        {
          id: "prod-2",
          name: "Loose Chips",
          description: null,
          basePriceCentavos: 5000,
          status: "active",
          variants: [],
          addons: [],
        },
      ],
    });
  });

  it("omits the uncategorized group entirely when every visible product has a category", async () => {
    table("menu_categories").__result = {
      data: [{ id: "cat-1", name: "Drinks", description: null }],
      error: null,
    };
    table("products").__result = {
      data: [
        {
          id: "prod-1",
          name: "Iced Latte",
          description: null,
          base_price_centavos: 12000,
          status: "active",
          category_id: "cat-1",
        },
      ],
      error: null,
    };
    table("product_variants").__result = { data: [], error: null };
    table("product_addons").__result = { data: [], error: null };

    const result = await repo.getPublicMenu("biz-1");

    expect(result.some((g) => g.category === null)).toBe(false);
  });

  it("returns only the uncategorized group when there are no active categories at all", async () => {
    table("menu_categories").__result = { data: [], error: null };
    table("products").__result = {
      data: [
        {
          id: "prod-1",
          name: "Loose Chips",
          description: null,
          base_price_centavos: 5000,
          status: "active",
          category_id: null,
        },
      ],
      error: null,
    };
    table("product_variants").__result = { data: [], error: null };
    table("product_addons").__result = { data: [], error: null };

    const result = await repo.getPublicMenu("biz-1");

    expect(result).toEqual([
      {
        category: null,
        products: [
          {
            id: "prod-1",
            name: "Loose Chips",
            description: null,
            basePriceCentavos: 5000,
            status: "active",
            variants: [],
            addons: [],
          },
        ],
      },
    ]);
  });
});
