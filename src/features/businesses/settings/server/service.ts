import { isInsidePhilippines, isValidCoordinates, type Coordinates } from "@/lib/maps/coordinates";
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

/**
 * A stored `(lat, lng)` pair, or null unless BOTH are present and valid. Used
 * on the read side; the write side's equivalent guarantee is in ../schemas.ts.
 */
export function toCoordinates(lat: number | null, lng: number | null): Coordinates | null {
  if (lat === null || lng === null) return null;
  const candidate = { lat, lng };
  return isValidCoordinates(candidate) ? candidate : null;
}

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
    // A stored half-pair is treated as no pin at all. The write path cannot
    // produce one (../schemas.ts refuses it), but this row may predate that
    // rule or have been written by an admin tool, and a map centred on
    // (lat, undefined) is a map in the Gulf of Guinea.
    coordinates: toCoordinates(row.lat, row.lng),
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
    lat: input.lat,
    lng: input.lng,
    opening_hours: input.openingHours as unknown as Json,
  };
}

/**
 * Logs a pin that landed outside the Philippines. It does NOT refuse the save -
 * the argument for warning rather than rejecting on a market boundary is at
 * `isInsidePhilippines` in src/lib/maps/coordinates.ts, and the merchant has
 * already seen the same warning next to the Save button.
 *
 * This exists so the case is visible in server logs too. A merchant who
 * genuinely has a shop in Sabah is one line in a log; a hundred of these in a
 * week is a bug in the picker, and without this we would never find out.
 */
export function warnIfOutsideMarket(businessId: string, input: BusinessProfileInput): void {
  if (input.lat === null || input.lng === null) return;
  if (isInsidePhilippines({ lat: input.lat, lng: input.lng })) return;

  console.warn(
    `[businesses] business ${businessId} saved a map pin outside the Philippines ` +
      `(${input.lat}, ${input.lng})`,
  );
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
  warnIfOutsideMarket(businessId, input);

  const { data, error } = await repo.updateBusinessProfile(businessId, buildProfilePatch(input));

  if (error || !data) {
    return { ok: false, message: error?.message ?? "Your changes could not be saved." };
  }

  emitBusinessProfileUpdated(businessId);
  return { ok: true, data: toView(data) };
}
