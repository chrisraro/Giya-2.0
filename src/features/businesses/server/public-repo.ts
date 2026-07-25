import { createClient } from "@/lib/supabase/server";

// Reads for the public, unauthenticated /b/[slug] business page. RLS
// (supabase/migrations/0007_catalog.sql, 000x identity migrations) is the
// real authorization boundary here - these policies are `to anon,
// authenticated`, so the normal server client already returns only
// public-safe rows for a signed-out visitor. The extra `.eq`/`.in`/`.is`
// filters below are defense-in-depth, matching the convention in
// src/features/menu/server/repo.ts, not the sole gate.

export type PublicBusiness = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  coverUrl: string | null;
  openingHours: unknown;
  cityName: string | null;
  businessTypeName: string | null;
};

export type PublicVariant = {
  id: string;
  name: string;
  priceCentavos: number;
};

export type PublicAddon = {
  id: string;
  name: string;
  priceDeltaCentavos: number;
};

export type PublicProduct = {
  id: string;
  name: string;
  description: string | null;
  basePriceCentavos: number;
  status: string;
  variants: PublicVariant[];
  addons: PublicAddon[];
};

export type PublicCategory = {
  id: string;
  name: string;
  description: string | null;
  products: PublicProduct[];
};

/**
 * Loads a business by its public slug, but only if it is active and not
 * soft-deleted - returns null otherwise (including "not found"), which the
 * page turns into a 404 via notFound(). Also resolves the city and business
 * type display names via their ref tables, mirroring the id -> name lookup
 * pattern in src/features/identity/actions.ts rather than an embedded
 * select, since the generated Database types don't model embedded joins.
 */
export async function getBusinessBySlug(slug: string): Promise<PublicBusiness | null> {
  const supabase = await createClient();

  const { data: business } = await supabase
    .from("businesses")
    .select(
      "id, slug, name, description, logo_url, cover_url, opening_hours, city_id, business_type_id",
    )
    .eq("slug", slug)
    .eq("status", "active")
    .is("deleted_at", null)
    .maybeSingle();

  if (!business) return null;

  let cityName: string | null = null;
  if (business.city_id) {
    const { data: city } = await supabase
      .from("ref_cities")
      .select("name")
      .eq("id", business.city_id)
      .maybeSingle();
    cityName = city?.name ?? null;
  }

  const { data: businessType } = await supabase
    .from("ref_business_types")
    .select("name")
    .eq("id", business.business_type_id)
    .maybeSingle();

  return {
    id: business.id,
    slug: business.slug,
    name: business.name,
    description: business.description,
    logoUrl: business.logo_url,
    coverUrl: business.cover_url,
    openingHours: business.opening_hours,
    cityName,
    businessTypeName: businessType?.name ?? null,
  };
}

/**
 * Loads a business's public menu: active categories in sort order, each
 * with its publicly visible products (status active/sold_out, ordered),
 * each product with its available variants and add-ons. Variants/addons are
 * fetched through the already-filtered product id list (never queried
 * directly by business_id) so a hidden or archived product's children can
 * never appear here - see the cascadeHideChildren comment in
 * src/features/menu/server/repo.ts for why the public RLS policies on
 * product_variants/product_addons can't check the parent product's status
 * themselves.
 */
export async function getPublicMenu(businessId: string): Promise<PublicCategory[]> {
  const supabase = await createClient();

  const { data: categories } = await supabase
    .from("menu_categories")
    .select("id, name, description")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .is("deleted_at", null)
    .order("sort", { ascending: true });

  const { data: products } = await supabase
    .from("products")
    .select("id, name, description, base_price_centavos, status, category_id")
    .eq("business_id", businessId)
    .in("status", ["active", "sold_out"])
    .is("deleted_at", null)
    .order("sort", { ascending: true });

  const visibleProductIds = (products ?? []).map((product) => product.id);

  let variantsByProduct = new Map<string, PublicVariant[]>();
  let addonsByProduct = new Map<string, PublicAddon[]>();

  if (visibleProductIds.length > 0) {
    const [{ data: variants }, { data: addons }] = await Promise.all([
      supabase
        .from("product_variants")
        .select("id, name, price_centavos, product_id")
        .in("product_id", visibleProductIds)
        .eq("is_available", true)
        .is("deleted_at", null)
        .order("sort", { ascending: true }),
      supabase
        .from("product_addons")
        .select("id, name, price_delta_centavos, product_id")
        .in("product_id", visibleProductIds)
        .eq("is_available", true)
        .is("deleted_at", null)
        .order("sort", { ascending: true }),
    ]);

    variantsByProduct = groupBy(variants ?? [], (variant) => variant.product_id, (variant) => ({
      id: variant.id,
      name: variant.name,
      priceCentavos: variant.price_centavos,
    }));
    addonsByProduct = groupBy(addons ?? [], (addon) => addon.product_id, (addon) => ({
      id: addon.id,
      name: addon.name,
      priceDeltaCentavos: addon.price_delta_centavos,
    }));
  }

  const productsByCategory = new Map<string | null, PublicProduct[]>();
  for (const product of products ?? []) {
    const publicProduct: PublicProduct = {
      id: product.id,
      name: product.name,
      description: product.description,
      basePriceCentavos: product.base_price_centavos,
      status: product.status,
      variants: variantsByProduct.get(product.id) ?? [],
      addons: addonsByProduct.get(product.id) ?? [],
    };
    const bucket = productsByCategory.get(product.category_id);
    if (bucket) bucket.push(publicProduct);
    else productsByCategory.set(product.category_id, [publicProduct]);
  }

  return (categories ?? []).map((category) => ({
    id: category.id,
    name: category.name,
    description: category.description,
    products: productsByCategory.get(category.id) ?? [],
  }));
}

function groupBy<Row, Item>(
  rows: Row[],
  keyOf: (row: Row) => string,
  itemOf: (row: Row) => Item,
): Map<string, Item[]> {
  const map = new Map<string, Item[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = map.get(key);
    if (bucket) bucket.push(itemOf(row));
    else map.set(key, [itemOf(row)]);
  }
  return map;
}
