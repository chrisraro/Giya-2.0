import type { Database } from "@/lib/supabase/types";

// Row DTOs re-exported from the generated Supabase types so the rest of the
// menu feature never reaches into `@/lib/supabase/types` directly.
export type MenuCategoryRow = Database["public"]["Tables"]["menu_categories"]["Row"];
export type ProductRow = Database["public"]["Tables"]["products"]["Row"];
export type ProductVariantRow = Database["public"]["Tables"]["product_variants"]["Row"];
export type ProductAddonRow = Database["public"]["Tables"]["product_addons"]["Row"];
export type ProductUpdatePatch = Database["public"]["Tables"]["products"]["Update"];

// OwnerBusiness now lives in the shared businesses feature; re-exported here
// so existing imports from "../types" within this feature keep working.
export type { OwnerBusiness } from "@/features/businesses/server/resolve-owner-business";

export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; message: string };
