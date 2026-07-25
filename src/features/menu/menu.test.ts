import { describe, it, expect, vi, beforeEach } from "vitest";

// A minimal fake of the supabase-js query builder: every filter/select
// method returns itself (so any chain shape works), `single`/`maybeSingle`
// resolve the configured `__result`, and the builder is itself thenable so
// chains that never call a terminal method (e.g. a bare `.update().eq()`)
// still resolve correctly when awaited directly, exactly like the real
// PostgrestFilterBuilder.
const mocks = vi.hoisted(() => {
  function makeBuilder() {
    const builder: Record<string, unknown> = {
      __result: { data: null, error: null } as { data: unknown; error: unknown },
    };
    for (const method of ["select", "insert", "update", "delete", "eq", "is", "order", "limit"]) {
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
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const repo = await import("./server/repo");
const actions = await import("./actions");
const { revalidatePath } = await import("next/cache");

type Builder = ReturnType<typeof mocks.makeBuilder>;

const AUTH_USER = { id: "user-1" };
const BUSINESS_STAFF_ROW = { business_id: "biz-1" };
const BUSINESS_ROW = { id: "biz-1", slug: "kape-diaria", name: "Kape Diaria", status: "active" };

let builders: Record<string, Builder>;

function table(name: string): Builder {
  const b = builders[name];
  if (!b) throw new Error(`no mock builder registered for table "${name}"`);
  return b;
}

function mockAuthed() {
  mocks.getUser.mockResolvedValue({ data: { user: AUTH_USER } });
}

function mockUnauthenticated() {
  mocks.getUser.mockResolvedValue({ data: { user: null } });
}

function mockNoActiveMembership() {
  table("business_staff").__result = { data: null, error: null };
}

beforeEach(() => {
  vi.clearAllMocks();

  builders = {
    business_staff: mocks.makeBuilder(),
    businesses: mocks.makeBuilder(),
    menu_categories: mocks.makeBuilder(),
    products: mocks.makeBuilder(),
    product_variants: mocks.makeBuilder(),
    product_addons: mocks.makeBuilder(),
  };
  table("business_staff").__result = { data: BUSINESS_STAFF_ROW, error: null };
  table("businesses").__result = { data: BUSINESS_ROW, error: null };
  // Sane defaults for the tenant-check existence lookups (repo.ts
  // productExistsForBusiness / categoryExistsForBusiness): "found" unless a
  // specific test overrides it to `null` to exercise the not-found path.
  table("products").__result = { data: { id: "prod-1" }, error: null };
  table("menu_categories").__result = { data: { id: "cat-1" }, error: null };

  mocks.from.mockImplementation((name: string) => table(name));

  mockAuthed();
});

// ---------------------------------------------------------------- repo.ts

describe("repo.resolveOwnerBusiness", () => {
  it("returns null when there is no signed-in user", async () => {
    mockUnauthenticated();
    expect(await repo.resolveOwnerBusiness()).toBeNull();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns null when the user has no active business_staff row", async () => {
    mockNoActiveMembership();
    expect(await repo.resolveOwnerBusiness()).toBeNull();
    expect(table("businesses").select).not.toHaveBeenCalled();
  });

  it("resolves the business from the caller's first active membership", async () => {
    const business = await repo.resolveOwnerBusiness();

    expect(business).toEqual(BUSINESS_ROW);
    expect(table("business_staff").eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(table("business_staff").eq).toHaveBeenCalledWith("status", "active");
    expect(table("businesses").eq).toHaveBeenCalledWith("id", "biz-1");
  });
});

describe("repo listing", () => {
  it("listCategories scopes to the business, excludes soft-deleted rows, and orders by sort", async () => {
    table("menu_categories").__result = { data: [{ id: "cat-1" }], error: null };

    const { data } = await repo.listCategories("biz-1");

    expect(data).toEqual([{ id: "cat-1" }]);
    expect(table("menu_categories").eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(table("menu_categories").is).toHaveBeenCalledWith("deleted_at", null);
    expect(table("menu_categories").order).toHaveBeenCalledWith("sort", { ascending: true });
  });

  it("listProducts scopes to the business and excludes soft-deleted rows", async () => {
    table("products").__result = { data: [{ id: "prod-1" }], error: null };

    const { data } = await repo.listProducts("biz-1");

    expect(data).toEqual([{ id: "prod-1" }]);
    expect(table("products").eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(table("products").is).toHaveBeenCalledWith("deleted_at", null);
  });
});

describe("repo child-visibility cascade", () => {
  it("archiveProduct soft-deletes the product and cascades is_available=false to variants and add-ons", async () => {
    table("products").__result = { data: { id: "prod-1", deleted_at: "now" }, error: null };

    await repo.archiveProduct("biz-1", "prod-1");

    expect(table("products").update).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: expect.any(String) }),
    );
    expect(table("product_variants").update).toHaveBeenCalledWith({ is_available: false });
    expect(table("product_variants").eq).toHaveBeenCalledWith("product_id", "prod-1");
    expect(table("product_addons").update).toHaveBeenCalledWith({ is_available: false });
    expect(table("product_addons").eq).toHaveBeenCalledWith("product_id", "prod-1");
  });

  it("does not cascade when archiveProduct's own update fails", async () => {
    table("products").__result = { data: null, error: { message: "db error" } };

    await repo.archiveProduct("biz-1", "prod-1");

    expect(table("product_variants").update).not.toHaveBeenCalled();
    expect(table("product_addons").update).not.toHaveBeenCalled();
  });

  it("setProductStatus('hidden') cascades is_available=false to variants and add-ons", async () => {
    table("products").__result = { data: { id: "prod-1", status: "hidden" }, error: null };

    await repo.setProductStatus("biz-1", "prod-1", "hidden");

    expect(table("product_variants").update).toHaveBeenCalledWith({ is_available: false });
    expect(table("product_addons").update).toHaveBeenCalledWith({ is_available: false });
  });

  it("setProductStatus('active') does NOT re-enable children automatically", async () => {
    table("products").__result = { data: { id: "prod-1", status: "active" }, error: null };

    await repo.setProductStatus("biz-1", "prod-1", "active");

    expect(table("product_variants").update).not.toHaveBeenCalled();
    expect(table("product_addons").update).not.toHaveBeenCalled();
  });

  it("updateProduct cascades too when the generic patch includes status:'hidden'", async () => {
    table("products").__result = { data: { id: "prod-1", status: "hidden" }, error: null };

    await repo.updateProduct("biz-1", "prod-1", { status: "hidden" });

    expect(table("product_variants").update).toHaveBeenCalledWith({ is_available: false });
    expect(table("product_addons").update).toHaveBeenCalledWith({ is_available: false });
  });

  it("updateProduct does not cascade for unrelated field changes", async () => {
    table("products").__result = { data: { id: "prod-1", name: "New name" }, error: null };

    await repo.updateProduct("biz-1", "prod-1", { name: "New name" });

    expect(table("product_variants").update).not.toHaveBeenCalled();
    expect(table("product_addons").update).not.toHaveBeenCalled();
  });

  it("toggleProductAvailability only touches the product's own is_available, not its children", async () => {
    table("products").__result = { data: { id: "prod-1", is_available: false }, error: null };

    await repo.toggleProductAvailability("biz-1", "prod-1", false);

    expect(table("products").update).toHaveBeenCalledWith({ is_available: false });
    expect(table("product_variants").update).not.toHaveBeenCalled();
    expect(table("product_addons").update).not.toHaveBeenCalled();
  });

  it("archiveProduct propagates the error and reports failure when the variants cascade update fails", async () => {
    table("products").__result = { data: { id: "prod-1", deleted_at: "now" }, error: null };
    table("product_variants").__result = { data: null, error: { message: "db error" } };

    const { data, error } = await repo.archiveProduct("biz-1", "prod-1");

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("setProductStatus('hidden') propagates the error when the add-ons cascade update fails", async () => {
    table("products").__result = { data: { id: "prod-1", status: "hidden" }, error: null };
    table("product_addons").__result = { data: null, error: { message: "db error" } };

    const { data, error } = await repo.setProductStatus("biz-1", "prod-1", "hidden");

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });
});

describe("repo hard deletes", () => {
  it("removeVariant hard-deletes scoped to the business", async () => {
    await repo.removeVariant("biz-1", "variant-1");

    expect(table("product_variants").delete).toHaveBeenCalled();
    expect(table("product_variants").eq).toHaveBeenCalledWith("id", "variant-1");
    expect(table("product_variants").eq).toHaveBeenCalledWith("business_id", "biz-1");
  });

  it("removeAddon hard-deletes scoped to the business", async () => {
    await repo.removeAddon("biz-1", "addon-1");

    expect(table("product_addons").delete).toHaveBeenCalled();
    expect(table("product_addons").eq).toHaveBeenCalledWith("id", "addon-1");
    expect(table("product_addons").eq).toHaveBeenCalledWith("business_id", "biz-1");
  });
});

// -------------------------------------------------------------- actions.ts

describe("actions: auth gating (representative sample)", () => {
  it("createCategory returns ok:false and touches nothing when unauthenticated", async () => {
    mockUnauthenticated();

    const result = await actions.createCategory({ name: "Drinks" });

    expect(result.ok).toBe(false);
    expect(table("menu_categories").insert).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("createProduct returns ok:false when unauthenticated", async () => {
    mockUnauthenticated();

    const result = await actions.createProduct({
      name: "Iced Latte",
      basePriceCentavos: 12000,
      categoryId: null,
      status: "active",
      isAvailable: true,
      images: [],
    });

    expect(result.ok).toBe(false);
    expect(table("products").insert).not.toHaveBeenCalled();
  });

  it("addVariant returns ok:false when unauthenticated", async () => {
    mockUnauthenticated();

    const result = await actions.addVariant({
      productId: "prod-1",
      name: "Large",
      priceCentavos: 15000,
    });

    expect(result.ok).toBe(false);
    expect(table("product_variants").insert).not.toHaveBeenCalled();
  });

  it("returns ok:false when the caller has no active business membership", async () => {
    mockNoActiveMembership();

    const result = await actions.createCategory({ name: "Drinks" });

    expect(result.ok).toBe(false);
    expect(table("menu_categories").insert).not.toHaveBeenCalled();
  });
});

describe("actions: createCategory", () => {
  it("parses input and inserts scoped to the resolved business", async () => {
    table("menu_categories").__result = {
      data: { id: "cat-1", business_id: "biz-1", name: "Drinks", sort: 0 },
      error: null,
    };

    const result = await actions.createCategory({ name: "Drinks" });

    expect(result).toEqual({
      ok: true,
      data: { id: "cat-1", business_id: "biz-1", name: "Drinks", sort: 0 },
    });
    expect(table("menu_categories").insert).toHaveBeenCalledWith({
      business_id: "biz-1",
      name: "Drinks",
      description: null,
      sort: 0,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/business/menu");
  });

  it("rejects an empty name without inserting", async () => {
    const result = await actions.createCategory({ name: "" });

    expect(result).toEqual({ ok: false, message: expect.any(String) });
    expect(table("menu_categories").insert).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a name over 80 characters", async () => {
    const result = await actions.createCategory({ name: "x".repeat(81) });

    expect(result.ok).toBe(false);
    expect(table("menu_categories").insert).not.toHaveBeenCalled();
  });
});

describe("actions: renameCategory", () => {
  it("renames the category scoped to the business", async () => {
    table("menu_categories").__result = { data: { id: "cat-1", name: "Beverages" }, error: null };

    const result = await actions.renameCategory({ categoryId: "11111111-1111-4111-8111-111111111111", name: "Beverages" });

    expect(result.ok).toBe(true);
    expect(table("menu_categories").update).toHaveBeenCalledWith({ name: "Beverages" });
    expect(table("menu_categories").eq).toHaveBeenCalledWith("id", "11111111-1111-4111-8111-111111111111");
    expect(table("menu_categories").eq).toHaveBeenCalledWith("business_id", "biz-1");
  });

  it("rejects a non-uuid categoryId", async () => {
    const result = await actions.renameCategory({ categoryId: "not-a-uuid", name: "Beverages" });

    expect(result.ok).toBe(false);
    expect(table("menu_categories").update).not.toHaveBeenCalled();
  });
});

describe("actions: reorderCategory", () => {
  it("updates sort scoped to the business", async () => {
    table("menu_categories").__result = { data: { id: "cat-1", sort: 3 }, error: null };

    const result = await actions.reorderCategory({
      categoryId: "11111111-1111-4111-8111-111111111111",
      sort: 3,
    });

    expect(result.ok).toBe(true);
    expect(table("menu_categories").update).toHaveBeenCalledWith({ sort: 3 });
  });

  it("rejects a non-integer sort", async () => {
    const result = await actions.reorderCategory({
      categoryId: "11111111-1111-4111-8111-111111111111",
      sort: 1.5,
    });

    expect(result.ok).toBe(false);
    expect(table("menu_categories").update).not.toHaveBeenCalled();
  });
});

describe("actions: archiveCategory", () => {
  it("soft-archives scoped to the business", async () => {
    table("menu_categories").__result = { data: { id: "cat-1", deleted_at: "now" }, error: null };

    const result = await actions.archiveCategory({ categoryId: "11111111-1111-4111-8111-111111111111" });

    expect(result.ok).toBe(true);
    expect(table("menu_categories").update).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: expect.any(String) }),
    );
  });

  it("rejects a missing categoryId", async () => {
    // @ts-expect-error deliberately invalid input for the test
    const result = await actions.archiveCategory({});

    expect(result.ok).toBe(false);
    expect(table("menu_categories").update).not.toHaveBeenCalled();
  });
});

const VALID_PRODUCT_INPUT = {
  name: "Iced Latte",
  basePriceCentavos: 12000,
  categoryId: null,
  status: "active" as const,
  isAvailable: true,
  images: ["https://cdn.giya.ph/products/iced-latte.jpg"],
};

describe("actions: createProduct", () => {
  it("parses input and inserts scoped to the resolved business", async () => {
    table("products").__result = { data: { id: "prod-1", ...VALID_PRODUCT_INPUT }, error: null };

    const result = await actions.createProduct(VALID_PRODUCT_INPUT);

    expect(result.ok).toBe(true);
    expect(table("products").insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-1",
        name: "Iced Latte",
        base_price_centavos: 12000,
        category_id: null,
        status: "active",
        is_available: true,
        images: ["https://cdn.giya.ph/products/iced-latte.jpg"],
      }),
    );
  });

  it("rejects a negative base price", async () => {
    const result = await actions.createProduct({ ...VALID_PRODUCT_INPUT, basePriceCentavos: -1 });

    expect(result.ok).toBe(false);
    expect(table("products").insert).not.toHaveBeenCalled();
  });

  it("rejects more than 6 images", async () => {
    const result = await actions.createProduct({
      ...VALID_PRODUCT_INPUT,
      images: Array.from({ length: 7 }, (_, i) => `https://cdn.giya.ph/products/${i}.jpg`),
    });

    expect(result.ok).toBe(false);
    expect(table("products").insert).not.toHaveBeenCalled();
  });

  it("rejects an invalid image url", async () => {
    const result = await actions.createProduct({ ...VALID_PRODUCT_INPUT, images: ["not-a-url"] });

    expect(result.ok).toBe(false);
    expect(table("products").insert).not.toHaveBeenCalled();
  });

  it("rejects an invalid availability window", async () => {
    const result = await actions.createProduct({
      ...VALID_PRODUCT_INPUT,
      availability: { days: [8], from: "11:00" },
    });

    expect(result.ok).toBe(false);
    expect(table("products").insert).not.toHaveBeenCalled();
  });

  it("accepts a valid availability window", async () => {
    table("products").__result = { data: { id: "prod-1" }, error: null };

    const result = await actions.createProduct({
      ...VALID_PRODUCT_INPUT,
      availability: { days: [1, 2, 3], from: "07:00", to: "14:00" },
    });

    expect(result.ok).toBe(true);
    expect(table("products").insert).toHaveBeenCalledWith(
      expect.objectContaining({ availability: { days: [1, 2, 3], from: "07:00", to: "14:00" } }),
    );
  });

  it("returns ok:false with 'Category not found.' when categoryId does not belong to the caller's business", async () => {
    table("menu_categories").__result = { data: null, error: null };

    const result = await actions.createProduct({
      ...VALID_PRODUCT_INPUT,
      categoryId: "33333333-3333-4333-8333-333333333333",
    });

    expect(result).toEqual({ ok: false, message: "Category not found." });
    expect(table("products").insert).not.toHaveBeenCalled();
  });

  it("proceeds when categoryId belongs to the caller's business", async () => {
    table("menu_categories").__result = { data: { id: "cat-1" }, error: null };
    table("products").__result = { data: { id: "prod-1" }, error: null };

    const result = await actions.createProduct({
      ...VALID_PRODUCT_INPUT,
      categoryId: "33333333-3333-4333-8333-333333333333",
    });

    expect(result.ok).toBe(true);
    expect(table("products").insert).toHaveBeenCalledWith(
      expect.objectContaining({ category_id: "33333333-3333-4333-8333-333333333333" }),
    );
  });
});

describe("actions: updateProduct", () => {
  it("updates only the fields provided, scoped to the business", async () => {
    table("products").__result = { data: { id: "prod-1", name: "New name" }, error: null };

    const result = await actions.updateProduct({ productId: "11111111-1111-4111-8111-111111111111", name: "New name" });

    expect(result.ok).toBe(true);
    expect(table("products").update).toHaveBeenCalledWith({ name: "New name" });
    expect(table("product_variants").update).not.toHaveBeenCalled();
  });

  it("cascades to variants/add-ons when status flips to hidden", async () => {
    table("products").__result = { data: { id: "prod-1", status: "hidden" }, error: null };

    const result = await actions.updateProduct({
      productId: "11111111-1111-4111-8111-111111111111",
      status: "hidden",
    });

    expect(result.ok).toBe(true);
    expect(table("product_variants").update).toHaveBeenCalledWith({ is_available: false });
    expect(table("product_addons").update).toHaveBeenCalledWith({ is_available: false });
  });

  it("rejects an invalid status value", async () => {
    const result = await actions.updateProduct({
      productId: "11111111-1111-4111-8111-111111111111",
      // @ts-expect-error deliberately invalid input for the test
      status: "deleted",
    });

    expect(result.ok).toBe(false);
    expect(table("products").update).not.toHaveBeenCalled();
  });

  it("returns ok:false with 'Category not found.' when the new categoryId does not belong to the caller's business", async () => {
    table("menu_categories").__result = { data: null, error: null };

    const result = await actions.updateProduct({
      productId: "11111111-1111-4111-8111-111111111111",
      categoryId: "33333333-3333-4333-8333-333333333333",
    });

    expect(result).toEqual({ ok: false, message: "Category not found." });
    expect(table("products").update).not.toHaveBeenCalled();
  });

  it("does not check category ownership when categoryId is not part of the patch", async () => {
    table("menu_categories").__result = { data: null, error: null };
    table("products").__result = { data: { id: "prod-1", name: "New name" }, error: null };

    const result = await actions.updateProduct({
      productId: "11111111-1111-4111-8111-111111111111",
      name: "New name",
    });

    expect(result.ok).toBe(true);
  });
});

describe("actions: archiveProduct", () => {
  it("soft-archives and cascades to children", async () => {
    table("products").__result = { data: { id: "prod-1", deleted_at: "now" }, error: null };

    const result = await actions.archiveProduct({ productId: "11111111-1111-4111-8111-111111111111" });

    expect(result.ok).toBe(true);
    expect(table("products").update).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: expect.any(String) }),
    );
    expect(table("product_variants").update).toHaveBeenCalledWith({ is_available: false });
    expect(table("product_addons").update).toHaveBeenCalledWith({ is_available: false });
  });

  it("rejects a non-uuid productId", async () => {
    const result = await actions.archiveProduct({ productId: "nope" });

    expect(result.ok).toBe(false);
    expect(table("products").update).not.toHaveBeenCalled();
  });

  it("returns ok:false (not ok:true) when the child-hide cascade fails partway through", async () => {
    table("products").__result = { data: { id: "prod-1", deleted_at: "now" }, error: null };
    table("product_variants").__result = { data: null, error: { message: "db error" } };

    const result = await actions.archiveProduct({ productId: "11111111-1111-4111-8111-111111111111" });

    expect(result.ok).toBe(false);
  });
});

describe("actions: setProductStatus", () => {
  it("hides the product and cascades to children", async () => {
    table("products").__result = { data: { id: "prod-1", status: "hidden" }, error: null };

    const result = await actions.setProductStatus({
      productId: "11111111-1111-4111-8111-111111111111",
      status: "hidden",
    });

    expect(result.ok).toBe(true);
    expect(table("product_variants").update).toHaveBeenCalledWith({ is_available: false });
  });

  it("does not cascade when setting status to sold_out", async () => {
    table("products").__result = { data: { id: "prod-1", status: "sold_out" }, error: null };

    const result = await actions.setProductStatus({
      productId: "11111111-1111-4111-8111-111111111111",
      status: "sold_out",
    });

    expect(result.ok).toBe(true);
    expect(table("product_variants").update).not.toHaveBeenCalled();
  });
});

describe("actions: toggleProductAvailability", () => {
  it("toggles is_available scoped to the business", async () => {
    table("products").__result = { data: { id: "prod-1", is_available: false }, error: null };

    const result = await actions.toggleProductAvailability({
      productId: "11111111-1111-4111-8111-111111111111",
      isAvailable: false,
    });

    expect(result.ok).toBe(true);
    expect(table("products").update).toHaveBeenCalledWith({ is_available: false });
  });

  it("rejects a non-boolean isAvailable", async () => {
    const result = await actions.toggleProductAvailability({
      productId: "11111111-1111-4111-8111-111111111111",
      // @ts-expect-error deliberately invalid input for the test
      isAvailable: "yes",
    });

    expect(result.ok).toBe(false);
    expect(table("products").update).not.toHaveBeenCalled();
  });
});

describe("actions: addVariant / removeVariant", () => {
  it("addVariant inserts scoped to the business and product", async () => {
    table("product_variants").__result = { data: { id: "variant-1", name: "Large" }, error: null };

    const result = await actions.addVariant({
      productId: "11111111-1111-4111-8111-111111111111",
      name: "Large",
      priceCentavos: 15000,
    });

    expect(result.ok).toBe(true);
    expect(table("product_variants").insert).toHaveBeenCalledWith({
      business_id: "biz-1",
      product_id: "11111111-1111-4111-8111-111111111111",
      name: "Large",
      price_centavos: 15000,
    });
  });

  it("addVariant rejects a negative price", async () => {
    const result = await actions.addVariant({
      productId: "11111111-1111-4111-8111-111111111111",
      name: "Large",
      priceCentavos: -1,
    });

    expect(result.ok).toBe(false);
    expect(table("product_variants").insert).not.toHaveBeenCalled();
  });

  it("removeVariant deletes scoped to the business", async () => {
    const result = await actions.removeVariant({ variantId: "22222222-2222-4222-8222-222222222222" });

    expect(result.ok).toBe(true);
    expect(table("product_variants").delete).toHaveBeenCalled();
    expect(table("product_variants").eq).toHaveBeenCalledWith("id", "22222222-2222-4222-8222-222222222222");
    expect(table("product_variants").eq).toHaveBeenCalledWith("business_id", "biz-1");
  });

  it("removeVariant rejects a non-uuid variantId", async () => {
    const result = await actions.removeVariant({ variantId: "nope" });

    expect(result.ok).toBe(false);
    expect(table("product_variants").delete).not.toHaveBeenCalled();
  });

  it("addVariant returns ok:false with 'Product not found.' when productId does not belong to the caller's business", async () => {
    table("products").__result = { data: null, error: null };

    const result = await actions.addVariant({
      productId: "11111111-1111-4111-8111-111111111111",
      name: "Large",
      priceCentavos: 15000,
    });

    expect(result).toEqual({ ok: false, message: "Product not found." });
    expect(table("product_variants").insert).not.toHaveBeenCalled();
  });
});

describe("actions: addAddon / removeAddon", () => {
  it("addAddon inserts scoped to the business and product", async () => {
    table("product_addons").__result = { data: { id: "addon-1", name: "Pearls" }, error: null };

    const result = await actions.addAddon({
      productId: "11111111-1111-4111-8111-111111111111",
      name: "Pearls",
      priceDeltaCentavos: 1500,
    });

    expect(result.ok).toBe(true);
    expect(table("product_addons").insert).toHaveBeenCalledWith({
      business_id: "biz-1",
      product_id: "11111111-1111-4111-8111-111111111111",
      name: "Pearls",
      price_delta_centavos: 1500,
    });
  });

  it("addAddon rejects a name over 60 characters", async () => {
    const result = await actions.addAddon({
      productId: "11111111-1111-4111-8111-111111111111",
      name: "x".repeat(61),
      priceDeltaCentavos: 1500,
    });

    expect(result.ok).toBe(false);
    expect(table("product_addons").insert).not.toHaveBeenCalled();
  });

  it("removeAddon deletes scoped to the business", async () => {
    const result = await actions.removeAddon({ addonId: "22222222-2222-4222-8222-222222222222" });

    expect(result.ok).toBe(true);
    expect(table("product_addons").delete).toHaveBeenCalled();
    expect(table("product_addons").eq).toHaveBeenCalledWith("id", "22222222-2222-4222-8222-222222222222");
    expect(table("product_addons").eq).toHaveBeenCalledWith("business_id", "biz-1");
  });

  it("removeAddon rejects a non-uuid addonId", async () => {
    const result = await actions.removeAddon({ addonId: "nope" });

    expect(result.ok).toBe(false);
    expect(table("product_addons").delete).not.toHaveBeenCalled();
  });

  it("addAddon returns ok:false with 'Product not found.' when productId does not belong to the caller's business", async () => {
    table("products").__result = { data: null, error: null };

    const result = await actions.addAddon({
      productId: "11111111-1111-4111-8111-111111111111",
      name: "Pearls",
      priceDeltaCentavos: 1500,
    });

    expect(result).toEqual({ ok: false, message: "Product not found." });
    expect(table("product_addons").insert).not.toHaveBeenCalled();
  });
});

describe("service.emitCatalogUpdated", () => {
  it("logs without throwing", async () => {
    const { emitCatalogUpdated } = await import("./server/service");
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});

    expect(() => emitCatalogUpdated("biz-1")).not.toThrow();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("biz-1"));

    spy.mockRestore();
  });
});
