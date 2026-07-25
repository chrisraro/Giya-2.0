import { createClient } from "@/lib/supabase/server";

import type { AddonInput, CategoryInput, ProductInput, ProductStatus, ProductUpdateInput, VariantInput } from "../schemas";
import type {
  MenuCategoryRow,
  OwnerBusiness,
  ProductAddonRow,
  ProductRow,
  ProductUpdatePatch,
  ProductVariantRow,
} from "../types";

// Repo is the only layer in this feature that touches the Supabase client.
// Every function below returns the raw `{ data, error }` shape the
// supabase-js query builder yields; service.ts is responsible for turning
// that into the { ok } | { ok: false, message } contract the UI expects.
// RLS (supabase/migrations/0007_catalog.sql) is the real authorization
// boundary; the `.eq("business_id", businessId)` scoping below is
// defense-in-depth, not the sole gate.

type Result<T> = { data: T | null; error: { message: string } | null };

/**
 * Resolves the signed-in caller's business by looking up their first active
 * `business_staff` row, then loading that business's id/slug/name/status.
 * Returns null if the caller has no session or no active membership.
 * Never accepts a business id from the client - this is the only path
 * server actions use to learn "whose" catalog they're mutating.
 */
export async function resolveOwnerBusiness(): Promise<OwnerBusiness | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: membership } = await supabase
    .from("business_staff")
    .select("business_id")
    .eq("user_id", user.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (!membership) return null;

  const { data: business } = await supabase
    .from("businesses")
    .select("id, slug, name, status")
    .eq("id", membership.business_id)
    .maybeSingle();

  return business ?? null;
}

export async function listCategories(businessId: string): Promise<Result<MenuCategoryRow[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_categories")
    .select("*")
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .order("sort", { ascending: true });

  return { data, error };
}

export async function listProducts(businessId: string): Promise<Result<ProductRow[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .order("sort", { ascending: true });

  return { data, error };
}

export async function listVariants(productId: string): Promise<Result<ProductVariantRow[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("product_variants")
    .select("*")
    .eq("product_id", productId)
    .is("deleted_at", null)
    .order("sort", { ascending: true });

  return { data, error };
}

export async function listAddons(productId: string): Promise<Result<ProductAddonRow[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("product_addons")
    .select("*")
    .eq("product_id", productId)
    .is("deleted_at", null)
    .order("sort", { ascending: true });

  return { data, error };
}

export async function insertCategory(
  businessId: string,
  input: CategoryInput,
): Promise<Result<MenuCategoryRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_categories")
    .insert({
      business_id: businessId,
      name: input.name,
      description: input.description ?? null,
      sort: input.sort ?? 0,
    })
    .select()
    .single();

  return { data, error };
}

export async function renameCategory(
  businessId: string,
  categoryId: string,
  name: string,
): Promise<Result<MenuCategoryRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_categories")
    .update({ name })
    .eq("id", categoryId)
    .eq("business_id", businessId)
    .select()
    .single();

  return { data, error };
}

export async function reorderCategory(
  businessId: string,
  categoryId: string,
  sort: number,
): Promise<Result<MenuCategoryRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_categories")
    .update({ sort })
    .eq("id", categoryId)
    .eq("business_id", businessId)
    .select()
    .single();

  return { data, error };
}

export async function archiveCategory(
  businessId: string,
  categoryId: string,
): Promise<Result<MenuCategoryRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_categories")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", categoryId)
    .eq("business_id", businessId)
    .select()
    .single();

  return { data, error };
}

export async function insertProduct(
  businessId: string,
  input: ProductInput,
): Promise<Result<ProductRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("products")
    .insert({
      business_id: businessId,
      name: input.name,
      description: input.description ?? null,
      base_price_centavos: input.basePriceCentavos,
      category_id: input.categoryId,
      status: input.status,
      is_available: input.isAvailable,
      images: input.images,
      availability: input.availability ?? {},
    })
    .select()
    .single();

  return { data, error };
}

export async function updateProduct(
  businessId: string,
  productId: string,
  input: ProductUpdateInput,
): Promise<Result<ProductRow>> {
  const supabase = await createClient();

  const patch: ProductUpdatePatch = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description ?? null;
  if (input.basePriceCentavos !== undefined) patch.base_price_centavos = input.basePriceCentavos;
  if (input.categoryId !== undefined) patch.category_id = input.categoryId;
  if (input.status !== undefined) patch.status = input.status;
  if (input.isAvailable !== undefined) patch.is_available = input.isAvailable;
  if (input.images !== undefined) patch.images = input.images;
  if (input.availability !== undefined) patch.availability = input.availability;

  const { data, error } = await supabase
    .from("products")
    .update(patch)
    .eq("id", productId)
    .eq("business_id", businessId)
    .select()
    .single();

  if (error) return { data: null, error };

  // updateProduct is the generic path the `updateProduct` action uses, and a
  // caller can flip status to 'hidden' through it (not just the dedicated
  // setProductStatus below). Cascade there too - see cascadeHideChildren's
  // comment for why this matters.
  if (input.status === "hidden") {
    await cascadeHideChildren(productId);
  }

  return { data, error: null };
}

// RLS mitigation (see .superpowers/sdd task-3 brief, docs/10-architecture/
// 12-multi-tenancy-rls.md): product_variants_public_select and
// product_addons_public_select only check `is_available` + `deleted_at`,
// never the parent product's `status`/`deleted_at`. So a hidden or archived
// product's children would otherwise still leak through the public
// consumer-menu read. Cascade `is_available = false` to a product's live
// variants/addons in the same logical operation whenever the product
// becomes non-public (hidden or archived). Un-hiding (status back to
// 'active') deliberately does NOT auto re-enable children - that's left to
// explicit addVariant/removeVariant-style toggles so a merchant doesn't
// accidentally resurrect a variant/add-on they'd manually 86'd earlier.
async function cascadeHideChildren(productId: string): Promise<void> {
  const supabase = await createClient();
  await Promise.all([
    supabase.from("product_variants").update({ is_available: false }).eq("product_id", productId),
    supabase.from("product_addons").update({ is_available: false }).eq("product_id", productId),
  ]);
}

export async function setProductStatus(
  businessId: string,
  productId: string,
  status: ProductStatus,
): Promise<Result<ProductRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("products")
    .update({ status })
    .eq("id", productId)
    .eq("business_id", businessId)
    .select()
    .single();

  if (error) return { data: null, error };

  if (status === "hidden") {
    await cascadeHideChildren(productId);
  }

  return { data, error: null };
}

export async function archiveProduct(
  businessId: string,
  productId: string,
): Promise<Result<ProductRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("products")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", productId)
    .eq("business_id", businessId)
    .select()
    .single();

  if (error) return { data: null, error };

  await cascadeHideChildren(productId);

  return { data, error: null };
}

export async function toggleProductAvailability(
  businessId: string,
  productId: string,
  isAvailable: boolean,
): Promise<Result<ProductRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("products")
    .update({ is_available: isAvailable })
    .eq("id", productId)
    .eq("business_id", businessId)
    .select()
    .single();

  return { data, error };
}

export async function addVariant(
  businessId: string,
  productId: string,
  input: VariantInput,
): Promise<Result<ProductVariantRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("product_variants")
    .insert({
      business_id: businessId,
      product_id: productId,
      name: input.name,
      price_centavos: input.priceCentavos,
    })
    .select()
    .single();

  return { data, error };
}

export async function removeVariant(
  businessId: string,
  variantId: string,
): Promise<Result<null>> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("product_variants")
    .delete()
    .eq("id", variantId)
    .eq("business_id", businessId);

  return { data: null, error };
}

export async function addAddon(
  businessId: string,
  productId: string,
  input: AddonInput,
): Promise<Result<ProductAddonRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("product_addons")
    .insert({
      business_id: businessId,
      product_id: productId,
      name: input.name,
      price_delta_centavos: input.priceDeltaCentavos,
    })
    .select()
    .single();

  return { data, error };
}

export async function removeAddon(businessId: string, addonId: string): Promise<Result<null>> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("product_addons")
    .delete()
    .eq("id", addonId)
    .eq("business_id", businessId);

  return { data: null, error };
}
