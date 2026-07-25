"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";

import {
  addonSchema,
  categorySchema,
  idSchema,
  productSchema,
  productStatusSchema,
  productUpdateSchema,
  variantSchema,
} from "./schemas";
import * as repo from "./server/repo";
import * as service from "./server/service";
import type { ActionResult, MenuCategoryRow, ProductAddonRow, ProductRow, ProductVariantRow } from "./types";

const MENU_PATH = "/business/menu";

const NOT_SIGNED_IN: ActionResult<never> = {
  ok: false,
  message: "You need to be signed in to do that.",
};

const NO_BUSINESS: ActionResult<never> = {
  ok: false,
  message: "No active business membership was found for your account.",
};

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid input.";
}

/**
 * Confirms the caller has a session and resolves their business server-side
 * (never trusting a business id supplied by the client). Every action below
 * calls this first; the business id it returns is the only one used in
 * subsequent repo/service calls.
 */
async function requireOwnerBusiness(): Promise<
  { ok: true; businessId: string } | { ok: false; result: ActionResult<never> }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, result: NOT_SIGNED_IN };
  }

  const business = await repo.resolveOwnerBusiness();
  if (!business) {
    return { ok: false, result: NO_BUSINESS };
  }

  return { ok: true, businessId: business.id };
}

// ------------------------------------------------------------- categories

export async function createCategory(input: {
  name: string;
  description?: string;
  sort?: number;
}): Promise<ActionResult<MenuCategoryRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = categorySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.createCategory(auth.businessId, parsed.data);
  if (result.ok) revalidatePath(MENU_PATH);
  return result;
}

const renameCategoryInputSchema = z.object({
  categoryId: idSchema,
  name: categorySchema.shape.name,
});

export async function renameCategory(input: {
  categoryId: string;
  name: string;
}): Promise<ActionResult<MenuCategoryRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = renameCategoryInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.renameCategory(auth.businessId, parsed.data.categoryId, parsed.data.name);
  if (result.ok) revalidatePath(MENU_PATH);
  return result;
}

const reorderCategoryInputSchema = z.object({
  categoryId: idSchema,
  sort: z.number().int(),
});

export async function reorderCategory(input: {
  categoryId: string;
  sort: number;
}): Promise<ActionResult<MenuCategoryRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = reorderCategoryInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.reorderCategory(auth.businessId, parsed.data.categoryId, parsed.data.sort);
  if (result.ok) revalidatePath(MENU_PATH);
  return result;
}

const archiveCategoryInputSchema = z.object({ categoryId: idSchema });

export async function archiveCategory(input: {
  categoryId: string;
}): Promise<ActionResult<MenuCategoryRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = archiveCategoryInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.archiveCategory(auth.businessId, parsed.data.categoryId);
  if (result.ok) revalidatePath(MENU_PATH);
  return result;
}

// ---------------------------------------------------------------- products

export async function createProduct(input: {
  name: string;
  description?: string;
  basePriceCentavos: number;
  categoryId: string | null;
  status: "active" | "hidden" | "sold_out";
  isAvailable: boolean;
  images: string[];
  availability?: { days: number[]; from?: string; to?: string };
}): Promise<ActionResult<ProductRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = productSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.createProduct(auth.businessId, parsed.data);
  if (result.ok) revalidatePath(MENU_PATH);
  return result;
}

const updateProductInputSchema = z.object({ productId: idSchema }).merge(productUpdateSchema);

export async function updateProduct(input: {
  productId: string;
  name?: string;
  description?: string;
  basePriceCentavos?: number;
  categoryId?: string | null;
  status?: "active" | "hidden" | "sold_out";
  isAvailable?: boolean;
  images?: string[];
  availability?: { days: number[]; from?: string; to?: string };
}): Promise<ActionResult<ProductRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = updateProductInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const { productId, ...patch } = parsed.data;
  const result = await service.updateProduct(auth.businessId, productId, patch);
  if (result.ok) revalidatePath(MENU_PATH);
  return result;
}

const archiveProductInputSchema = z.object({ productId: idSchema });

export async function archiveProduct(input: { productId: string }): Promise<ActionResult<ProductRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = archiveProductInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.archiveProduct(auth.businessId, parsed.data.productId);
  if (result.ok) revalidatePath(MENU_PATH);
  return result;
}

const toggleProductAvailabilityInputSchema = z.object({
  productId: idSchema,
  isAvailable: z.boolean(),
});

export async function toggleProductAvailability(input: {
  productId: string;
  isAvailable: boolean;
}): Promise<ActionResult<ProductRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = toggleProductAvailabilityInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.toggleProductAvailability(
    auth.businessId,
    parsed.data.productId,
    parsed.data.isAvailable,
  );
  if (result.ok) revalidatePath(MENU_PATH);
  return result;
}

// Not part of the UI's action list yet, but exposed for a future dedicated
// "hide"/"unhide" quick-action; routes through the same cascade as
// updateProduct when status becomes 'hidden' (see repo.ts).
const setProductStatusInputSchema = z.object({
  productId: idSchema,
  status: productStatusSchema,
});

export async function setProductStatus(input: {
  productId: string;
  status: "active" | "hidden" | "sold_out";
}): Promise<ActionResult<ProductRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = setProductStatusInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.setProductStatus(auth.businessId, parsed.data.productId, parsed.data.status);
  if (result.ok) revalidatePath(MENU_PATH);
  return result;
}

// ---------------------------------------------------------------- variants

const addVariantInputSchema = z.object({ productId: idSchema }).merge(variantSchema);

export async function addVariant(input: {
  productId: string;
  name: string;
  priceCentavos: number;
}): Promise<ActionResult<ProductVariantRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = addVariantInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const { productId, ...variantInput } = parsed.data;
  const result = await service.addVariant(auth.businessId, productId, variantInput);
  if (result.ok) revalidatePath(MENU_PATH);
  return result;
}

const removeVariantInputSchema = z.object({ variantId: idSchema });

export async function removeVariant(input: { variantId: string }): Promise<ActionResult<null>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = removeVariantInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.removeVariant(auth.businessId, parsed.data.variantId);
  if (result.ok) revalidatePath(MENU_PATH);
  return result;
}

// ------------------------------------------------------------------ addons

const addAddonInputSchema = z.object({ productId: idSchema }).merge(addonSchema);

export async function addAddon(input: {
  productId: string;
  name: string;
  priceDeltaCentavos: number;
}): Promise<ActionResult<ProductAddonRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = addAddonInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const { productId, ...addonInput } = parsed.data;
  const result = await service.addAddon(auth.businessId, productId, addonInput);
  if (result.ok) revalidatePath(MENU_PATH);
  return result;
}

const removeAddonInputSchema = z.object({ addonId: idSchema });

export async function removeAddon(input: { addonId: string }): Promise<ActionResult<null>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = removeAddonInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.removeAddon(auth.businessId, parsed.data.addonId);
  if (result.ok) revalidatePath(MENU_PATH);
  return result;
}
