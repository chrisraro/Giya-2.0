import { z } from "zod";

// Shared Zod schemas for the catalog (menu) domain. Mirrors the DB checks in
// supabase/migrations/0007_catalog.sql so invalid input is rejected before it
// ever reaches Postgres; the DB constraints remain the source of truth.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const categorySchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(1000).optional(),
  sort: z.number().int().optional(),
});
export type CategoryInput = z.infer<typeof categorySchema>;

export const productStatusSchema = z.enum(["active", "hidden", "sold_out"]);
export type ProductStatus = z.infer<typeof productStatusSchema>;

// Optional day/time window a product is orderable in, e.g. a breakfast-only
// item. `days` uses ISO-ish 1 (Monday) - 7 (Sunday) per doc 22.
export const availabilityWindowSchema = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1),
  from: z.string().regex(HHMM, "Expected HH:MM").optional(),
  to: z.string().regex(HHMM, "Expected HH:MM").optional(),
});
export type AvailabilityWindow = z.infer<typeof availabilityWindowSchema>;

export const productSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  basePriceCentavos: z.number().int().min(0),
  categoryId: z.string().uuid().nullable(),
  status: productStatusSchema,
  isAvailable: z.boolean(),
  images: z.array(z.string().url()).max(6),
  availability: availabilityWindowSchema.optional(),
});
export type ProductInput = z.infer<typeof productSchema>;

// Partial variant used by updateProduct: derived from productSchema (rather
// than TS's `Partial<ProductInput>`) so optional-field typing stays
// consistent with zod's inferred shape under exactOptionalPropertyTypes.
export const productUpdateSchema = productSchema.partial();
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;

export const variantSchema = z.object({
  name: z.string().min(1).max(60),
  priceCentavos: z.number().int().min(0),
});
export type VariantInput = z.infer<typeof variantSchema>;

export const addonSchema = z.object({
  name: z.string().min(1).max(60),
  priceDeltaCentavos: z.number().int().min(0),
});
export type AddonInput = z.infer<typeof addonSchema>;

// A uuid primary key referenced from action input (categoryId, productId,
// variantId, addonId). Never trust one from the client without this parse.
export const idSchema = z.string().uuid();
