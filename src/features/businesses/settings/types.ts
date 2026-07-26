import type { Coordinates } from "@/lib/maps/coordinates";

import type { OpeningHoursEntry } from "./schemas";

export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; message: string; code?: string };

export interface BusinessSocials {
  facebook: string | null;
  instagram: string | null;
  tiktok: string | null;
}

/**
 * What the settings screen renders. Split into the part the form owns and the
 * part it only displays, so the boundary is visible in the type rather than
 * only in the component.
 */
export interface BusinessProfileView {
  /** Editable presentation fields. */
  name: string;
  description: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  socials: BusinessSocials;
  addressLine: string | null;
  barangay: string | null;
  postalCode: string | null;
  /**
   * The map pin, or null when it has never been set. A PAIR rather than two
   * nullable numbers, so "half a location" is not representable in the type
   * that the picker and the public page both read.
   */
  coordinates: Coordinates | null;
  openingHours: OpeningHoursEntry[];

  /**
   * Read-only. Shown because a merchant needs to know why activation is
   * unavailable (doc 32 section 2.3), never sent back by the form: the write
   * path has no key for any of these.
   */
  readOnly: {
    slug: string;
    status: string;
    verifiedAt: string | null;
    plan: string;
  };
}
