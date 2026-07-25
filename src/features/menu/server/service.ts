import type { AddonInput, CategoryInput, ProductInput, ProductStatus, ProductUpdateInput, VariantInput } from "../schemas";
import type { ActionResult, MenuCategoryRow, ProductAddonRow, ProductRow, ProductVariantRow } from "../types";
import * as repo from "./repo";

// Thin orchestration over repo.ts: translate the repo's { data, error } shape
// into the { ok } | { ok: false, message } contract actions.ts hands back to
// the UI, and fire the catalog-updated notification after every mutation
// that changes what a customer would see on the public menu.

/**
 * Notifies downstream consumers that a business's catalog changed. Today
 * this is just a log line; it is the seam a future embeddings-refresh job
 * hangs off of once it exists.
 */
export function emitCatalogUpdated(businessId: string): void {
  console.info(`[menu] catalog updated for business ${businessId}`);
  // TODO(api): wire embeddings refresh job (doc 38)
}

function toResult<T>(data: T | null, error: { message: string } | null): ActionResult<T> {
  if (error) return { ok: false, message: error.message };
  if (data === null) return { ok: true };
  return { ok: true, data };
}

export async function createCategory(
  businessId: string,
  input: CategoryInput,
): Promise<ActionResult<MenuCategoryRow>> {
  const { data, error } = await repo.insertCategory(businessId, input);
  if (error) return toResult(data, error);
  emitCatalogUpdated(businessId);
  return toResult(data, error);
}

export async function renameCategory(
  businessId: string,
  categoryId: string,
  name: string,
): Promise<ActionResult<MenuCategoryRow>> {
  const { data, error } = await repo.renameCategory(businessId, categoryId, name);
  if (error) return toResult(data, error);
  emitCatalogUpdated(businessId);
  return toResult(data, error);
}

export async function reorderCategory(
  businessId: string,
  categoryId: string,
  sort: number,
): Promise<ActionResult<MenuCategoryRow>> {
  const { data, error } = await repo.reorderCategory(businessId, categoryId, sort);
  if (error) return toResult(data, error);
  emitCatalogUpdated(businessId);
  return toResult(data, error);
}

export async function archiveCategory(
  businessId: string,
  categoryId: string,
): Promise<ActionResult<MenuCategoryRow>> {
  const { data, error } = await repo.archiveCategory(businessId, categoryId);
  if (error) return toResult(data, error);
  emitCatalogUpdated(businessId);
  return toResult(data, error);
}

export async function createProduct(
  businessId: string,
  input: ProductInput,
): Promise<ActionResult<ProductRow>> {
  const { data, error } = await repo.insertProduct(businessId, input);
  if (error) return toResult(data, error);
  emitCatalogUpdated(businessId);
  return toResult(data, error);
}

export async function updateProduct(
  businessId: string,
  productId: string,
  input: ProductUpdateInput,
): Promise<ActionResult<ProductRow>> {
  const { data, error } = await repo.updateProduct(businessId, productId, input);
  if (error) return toResult(data, error);
  emitCatalogUpdated(businessId);
  return toResult(data, error);
}

// Archiving is a visibility-changing mutation: repo.archiveProduct already
// cascades is_available=false to the product's variants/addons (see the
// comment on cascadeHideChildren in repo.ts) so this layer just needs to
// forward the call and notify.
export async function archiveProduct(
  businessId: string,
  productId: string,
): Promise<ActionResult<ProductRow>> {
  const { data, error } = await repo.archiveProduct(businessId, productId);
  if (error) return toResult(data, error);
  emitCatalogUpdated(businessId);
  return toResult(data, error);
}

// Setting status to 'hidden' is a visibility-changing mutation: repo.
// setProductStatus cascades is_available=false to the product's variants/
// addons in that case (see repo.ts). Setting status to 'active'/'sold_out'
// does not touch children.
export async function setProductStatus(
  businessId: string,
  productId: string,
  status: ProductStatus,
): Promise<ActionResult<ProductRow>> {
  const { data, error } = await repo.setProductStatus(businessId, productId, status);
  if (error) return toResult(data, error);
  emitCatalogUpdated(businessId);
  return toResult(data, error);
}

export async function toggleProductAvailability(
  businessId: string,
  productId: string,
  isAvailable: boolean,
): Promise<ActionResult<ProductRow>> {
  const { data, error } = await repo.toggleProductAvailability(businessId, productId, isAvailable);
  if (error) return toResult(data, error);
  emitCatalogUpdated(businessId);
  return toResult(data, error);
}

export async function addVariant(
  businessId: string,
  productId: string,
  input: VariantInput,
): Promise<ActionResult<ProductVariantRow>> {
  const { data, error } = await repo.addVariant(businessId, productId, input);
  if (error) return toResult(data, error);
  emitCatalogUpdated(businessId);
  return toResult(data, error);
}

export async function removeVariant(
  businessId: string,
  variantId: string,
): Promise<ActionResult<null>> {
  const { data, error } = await repo.removeVariant(businessId, variantId);
  if (error) return toResult(data, error);
  emitCatalogUpdated(businessId);
  return toResult(data, error);
}

export async function addAddon(
  businessId: string,
  productId: string,
  input: AddonInput,
): Promise<ActionResult<ProductAddonRow>> {
  const { data, error } = await repo.addAddon(businessId, productId, input);
  if (error) return toResult(data, error);
  emitCatalogUpdated(businessId);
  return toResult(data, error);
}

export async function removeAddon(
  businessId: string,
  addonId: string,
): Promise<ActionResult<null>> {
  const { data, error } = await repo.removeAddon(businessId, addonId);
  if (error) return toResult(data, error);
  emitCatalogUpdated(businessId);
  return toResult(data, error);
}
