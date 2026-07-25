import type { Json } from "@/lib/supabase/types";

import { parseOpeningHours, parseSocials } from "../hours";
import type { BusinessProfileInput } from "../schemas";
import type { ActionResult, BusinessProfileView } from "../types";
import * as repo from "./repo";
import type { BusinessRow } from "./repo";

// The jsonb parsers live in ../hours.ts (pure, no DB imports) so the form
// component can share them; they are re-exported here because this module is
// the settings slice's server-side entry point and its callers already import
// from it.
export {
  DEFAULT_CLOSE,
  DEFAULT_OPEN,
  WEEKDAY_LABELS,
  parseOpeningHours,
  parseSocials,
} from "../hours";

// Orchestration over repo.ts: shape the row for the screen, and build the one
// write. The allowlist fence lives in repo.ts; this layer's job is to build a
// patch that only ever names allowed columns.

function toView(row: BusinessRow): BusinessProfileView {
  return {
    name: row.name,
    description: row.description,
    phone: row.phone,
    email: row.email,
    website: row.website,
    socials: parseSocials(row.socials),
    addressLine: row.address_line,
    barangay: row.barangay,
    postalCode: row.postal_code,
    openingHours: parseOpeningHours(row.opening_hours),
    readOnly: {
      slug: row.slug,
      status: row.status,
      verifiedAt: row.verified_at,
      plan: row.plan,
    },
  };
}

/**
 * Returns `{ ok: false }` when the read failed OR when the row is missing, so
 * the page can show "could not load" rather than an empty form the merchant
 * would fill in and then fail to save.
 */
export async function loadProfile(businessId: string): Promise<ActionResult<BusinessProfileView>> {
  const { data, error } = await repo.getBusinessProfile(businessId);
  if (error) return { ok: false, message: error.message };
  if (!data) return { ok: false, message: "That business could not be found." };

  return { ok: true, data: toView(data) };
}

/**
 * Builds the update patch. Every key is named literally, from the allowlist in
 * repo.ts; there is no spread of the input object anywhere in this function,
 * because a spread is how an unexpected key reaches a column.
 */
export function buildProfilePatch(input: BusinessProfileInput) {
  const socials: Record<string, string> = {};
  if (input.facebook) socials.facebook = input.facebook;
  if (input.instagram) socials.instagram = input.instagram;
  if (input.tiktok) socials.tiktok = input.tiktok;

  return {
    name: input.name,
    description: input.description,
    phone: input.phone,
    email: input.email,
    website: input.website,
    socials: socials as Json,
    address_line: input.addressLine,
    barangay: input.barangay,
    postal_code: input.postalCode,
    opening_hours: input.openingHours as unknown as Json,
  };
}

/**
 * The seam a future embeddings-refresh job hangs off. Doc 32 section 4: hours
 * and profile text feed the consumer display and the AI answers, so a save has
 * to invalidate what the assistant believes. Today it is a log line, same as
 * src/features/menu/server/service.ts's `emitCatalogUpdated`.
 */
export function emitBusinessProfileUpdated(businessId: string): void {
  console.info(`[businesses] profile updated for business ${businessId}`);
  // TODO(api): wire embeddings refresh for business_info / hours sources (doc 38)
}

export async function saveProfile(
  businessId: string,
  input: BusinessProfileInput,
): Promise<ActionResult<BusinessProfileView>> {
  const { data, error } = await repo.updateBusinessProfile(businessId, buildProfilePatch(input));

  if (error || !data) {
    return { ok: false, message: error?.message ?? "Your changes could not be saved." };
  }

  emitBusinessProfileUpdated(businessId);
  return { ok: true, data: toView(data) };
}
