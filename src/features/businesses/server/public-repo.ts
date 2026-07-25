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

export type PublicMenuCategory = {
  id: string;
  name: string;
  description: string | null;
};

/**
 * One section of a business's public menu: a real category, or `null` for
 * the trailing "uncategorized" bucket (rendered by PublicMenu as "More").
 * SMEs very commonly leave products uncategorized, so that bucket has to
 * be a first-class group rather than silently dropped - see getPublicMenu.
 */
export type PublicMenuGroup = {
  category: PublicMenuCategory | null;
  products: PublicProduct[];
};

export type PublicReward = {
  id: string;
  name: string;
  description: string | null;
  pointsCost: number;
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
 *
 * A product with no category_id (very common for SMEs that haven't set up
 * categories yet) is never dropped: it's collected into a trailing group
 * with `category: null`, appended after every real category, only when at
 * least one such product exists. PublicMenu renders that group as "More".
 */
export async function getPublicMenu(businessId: string): Promise<PublicMenuGroup[]> {
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

  const groups: PublicMenuGroup[] = (categories ?? []).map((category) => ({
    category: {
      id: category.id,
      name: category.name,
      description: category.description,
    },
    products: productsByCategory.get(category.id) ?? [],
  }));

  const uncategorized = productsByCategory.get(null) ?? [];
  if (uncategorized.length > 0) {
    groups.push({ category: null, products: uncategorized });
  }

  return groups;
}

/**
 * A business's currently claimable rewards for its public `/b/[slug]` page:
 * active, non-deleted rewards belonging to a campaign that is active and
 * inside its schedule window - the same eligibility rule as
 * src/features/rewards/server/repo.ts's listClaimableRewards (see its
 * comment for why the window check can't live in RLS alone), just scoped to
 * one business_id instead of the whole catalog. An empty result means the
 * page's Rewards section is omitted entirely, not rendered empty.
 */
export async function getPublicRewards(businessId: string): Promise<PublicReward[]> {
  const supabase = await createClient();

  const { data: rewards, error } = await supabase
    .from("rewards")
    .select("id, campaign_id, name, description, points_cost")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .is("deleted_at", null);

  if (error || !rewards || rewards.length === 0) return [];

  const campaignIds = Array.from(new Set(rewards.map((reward) => reward.campaign_id)));
  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id, starts_at, ends_at")
    .in("id", campaignIds)
    .eq("status", "active")
    .is("deleted_at", null);

  const now = new Date();
  const liveCampaignIds = new Set(
    (campaigns ?? [])
      .filter((campaign) => {
        const startsOk = !campaign.starts_at || new Date(campaign.starts_at) <= now;
        const endsOk = !campaign.ends_at || new Date(campaign.ends_at) > now;
        return startsOk && endsOk;
      })
      .map((campaign) => campaign.id),
  );

  return rewards
    .filter((reward) => liveCampaignIds.has(reward.campaign_id))
    .map((reward) => ({
      id: reward.id,
      name: reward.name,
      description: reward.description,
      pointsCost: reward.points_cost,
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
