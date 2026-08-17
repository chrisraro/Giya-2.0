import { isValidCoordinates, type Coordinates } from "@/lib/maps/coordinates";
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
  /**
   * The street address, already assembled from `address_line`, `barangay`, the
   * city name and `postal_code` into one display string, or null when the
   * merchant has filled in none of them.
   *
   * Assembled HERE rather than on the page because it is the fallback the map
   * degrades to, and a fallback that two callers each build slightly
   * differently is a fallback that will eventually differ from the thing it
   * falls back from.
   */
  addressText: string | null;
  /**
   * The map pin, or null when unset - which is the normal state, since the
   * picker only landed with this slice. Both columns or neither: a half pair is
   * read as no pin (see `toCoordinates`).
   */
  coordinates: Coordinates | null;
};

/**
 * A business reduced to what a picker row needs: the name, the avatar, and
 * enough context to tell two similarly named shops apart. Used by the `/scan`
 * store chooser; deliberately narrower than `PublicBusiness` so a list read
 * never pulls cover images and opening hours it will not render.
 */
export type BusinessSummary = {
  id: string;
  /**
   * The public slug, so a picker row can link to `/b/[slug]` as well as to the
   * id-keyed `/scan?business={id}`. Selected here rather than looked up again
   * by the caller: it is one more column on a read that already runs, and it is
   * the same publicly readable column `/b/[slug]` resolves against.
   */
  slug: string;
  name: string;
  logoUrl: string | null;
  cityName: string | null;
  businessTypeName: string | null;
  /**
   * The map pin, or null when the shop has never been geocoded, which is the
   * common case. Carried on the SUMMARY and not only on `PublicBusiness`
   * because /discover draws a map of its whole filtered result set, and the
   * alternative is a second read of the same rows for two more columns.
   *
   * A null here means absent from the map. It never means absent from the
   * list: see `listActiveBusinesses`.
   */
  coordinates: Coordinates | null;
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
    // One literal string, deliberately not a concatenation: supabase-js infers
    // the row type from the select as a string LITERAL, and splitting it over
    // two quoted parts collapses that inference to an error type.
    .select(
      "id, slug, name, description, logo_url, cover_url, opening_hours, city_id, business_type_id, address_line, barangay, postal_code, lat, lng",
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
    addressText: formatAddress({
      addressLine: business.address_line,
      barangay: business.barangay,
      cityName,
      postalCode: business.postal_code,
    }),
    coordinates: toPublicCoordinates(business.lat, business.lng),
  };
}

/**
 * The address as one line, in Philippine reading order (street, barangay, city,
 * postcode). Blank parts are dropped rather than leaving a run of commas, and
 * an entirely empty address is null so the caller can omit the block instead of
 * rendering an empty heading.
 */
export function formatAddress(parts: {
  addressLine: string | null;
  barangay: string | null;
  cityName: string | null;
  postalCode: string | null;
}): string | null {
  const ordered = [parts.addressLine, parts.barangay, parts.cityName, parts.postalCode]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));

  return ordered.length > 0 ? ordered.join(", ") : null;
}

/**
 * A stored pair, or null unless both columns are present and in range. The
 * write path cannot produce a half pair, but a row predating the picker or
 * touched by an admin tool can, and a map centred on a partial pair points at
 * the Atlantic with total confidence.
 */
function toPublicCoordinates(lat: number | null, lng: number | null): Coordinates | null {
  if (lat === null || lng === null) return null;
  const candidate = { lat, lng };
  return isValidCoordinates(candidate) ? candidate : null;
}

export interface ListActiveBusinessesArgs {
  readonly query?: string | undefined;
  readonly ids?: readonly string[] | undefined;
  readonly cityId?: string | undefined;
  readonly businessTypeId?: string | undefined;
  readonly limit: number;
}

export async function listActiveBusinesses(
  args: ListActiveBusinessesArgs,
): Promise<BusinessSummary[]> {
  if (args.ids !== undefined && args.ids.length === 0) return [];

  const supabase = await createClient();

  let select = supabase
    .from("businesses")
    .select("id, slug, name, logo_url, city_id, business_type_id, lat, lng")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("name", { ascending: true })
    .limit(args.limit);

  if (args.ids !== undefined) select = select.in("id", [...args.ids]);
  if (args.query) select = select.ilike("name", `%${args.query}%`);
  if (args.cityId) select = select.eq("city_id", args.cityId);
  if (args.businessTypeId) select = select.eq("business_type_id", args.businessTypeId);

  const { data, error } = await select;

  // EMPTY IS NOT THE SAME AS FAILED, and this read is the one place that
  // distinction is most expensive to get wrong: /discover renders "No matching
  // shops found" for an empty list, so swallowing an error here tells a
  // consumer their search was too narrow while the database is down. Same rule
  // as src/features/rewards/server/repo.ts and the loyalty repo - throw on the
  // error, return empty only for genuinely empty. /home already catches around
  // its own optional reads and can do the same here if it wants to degrade.
  if (error) {
    throw new Error(`Failed to list active businesses: ${error.message}`);
  }
  if (!data || data.length === 0) return [];

  // Two `.in()` lookups rather than one per row, mirroring the id -> name
  // resolution in getBusinessBySlug (the generated Database types do not model
  // embedded joins, so PostgREST embeds are not used anywhere in this repo).
  const cityIds = Array.from(
    new Set(data.flatMap((business) => (business.city_id ? [business.city_id] : []))),
  );
  const typeIds = Array.from(new Set(data.map((business) => business.business_type_id)));

  const [cityNames, typeNames] = await Promise.all([
    refNames(supabase, "ref_cities", cityIds),
    refNames(supabase, "ref_business_types", typeIds),
  ]);

  return data.map((business) => ({
    id: business.id,
    slug: business.slug,
    name: business.name,
    logoUrl: business.logo_url,
    cityName: business.city_id ? (cityNames.get(business.city_id) ?? null) : null,
    businessTypeName: typeNames.get(business.business_type_id) ?? null,
    // Note what does NOT happen here: an unpinned shop is not filtered out.
    // The map is built from the subset of this list that has coordinates, and
    // losing a shop from a consumer's search because nobody geocoded it would
    // be a far worse bug than a sparse map.
    coordinates: toPublicCoordinates(business.lat, business.lng),
  }));
}

async function refNames(
  supabase: Awaited<ReturnType<typeof createClient>>,
  table: "ref_cities" | "ref_business_types",
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data } = await supabase.from(table).select("id, name").in("id", [...ids]);
  return new Map((data ?? []).map((row) => [row.id, row.name]));
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

export async function listRefCities(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("ref_cities").select("id, name").order("name");
  return data ?? [];
}

export async function listRefBusinessTypes(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("ref_business_types").select("id, name").order("name");
  return data ?? [];
}
