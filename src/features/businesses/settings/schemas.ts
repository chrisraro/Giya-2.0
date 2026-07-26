import { z } from "zod";

import {
  LATITUDE_MAX,
  LATITUDE_MIN,
  LONGITUDE_MAX,
  LONGITUDE_MIN,
  roundCoordinate,
} from "@/lib/maps/coordinates";

// ===========================================================================
// The business profile form's input contract.
//
// WHAT IS NOT HERE IS THE POINT. `businesses_staff_update`
// (supabase/migrations/0011_identity_table_staff_policies.sql) is row-scoped:
// it asks "is the caller an active owner or manager of this business" and says
// nothing about columns. supabase/README.md's "Known limitations" records the
// consequence in as many words - "owner updates could touch
// `businesses.status` / `verified_at` / `plan`" - and marks the column-level
// grant that would fence them as an owed follow-up migration.
//
// Until that migration exists, THIS SCHEMA IS THE FENCE. It is a strict object,
// so a request carrying `status`, `verified_at`, `plan`, `plan_limits`, `slug`,
// `suspended_reason`, `google_place_id`, `city_id`, `business_type_id`,
// `logo_url`, `cover_url` or `gallery` does not have those keys quietly dropped
// - it fails to parse, and the action answers with a validation message.
// server/repo.ts then asserts the same allowlist a second time on the way to
// Postgres, so a future caller that builds a patch by hand rather than through
// this schema still cannot reach a column this form has no business writing.
//
// The exclusions and why, in one place:
//
//   status, verified_at   The verification state machine owns both (doc 32
//                         section 2). A merchant editing their own address must
//                         not be able to mark themselves verified.
//   plan, plan_limits     Entitlements. Billing, not presentation.
//   suspended_reason      Platform moderation, written by admins.
//   slug                  Editable in principle, but doc 32 section 4 attaches
//                         real rules to it (unique, once per 30 days after
//                         activation, a printed-QR warning). A text input with
//                         none of that is worse than no input.
//   google_place_id       A Google Places identifier, and the map picker this
//                         form now carries is not Google's (see
//                         src/lib/maps/tile-source.ts for why). Writing a
//                         column named for one vendor with an id minted by
//                         another is how a schema starts lying. It stays
//                         unwritten until something actually mints Place ids.
//   city_id,              Reference-table pickers this slice does not build.
//   business_type_id
//   logo_url, cover_url,  Need the public-bucket upload + image queue.
//   gallery
//
// WHAT CHANGED, AND WHY IT IS A WIDENING AND NOT A HOLE.
//
// `lat` and `lng` used to be on that list, excluded with the note "doc 32
// section 4 sets these from a Maps picker. Free-text coordinates are a
// data-quality trap, so the field waits for the picker." The picker now exists
// (../components/location-picker.tsx), so the stated condition is met and the
// two columns move across - deliberately, one pair at a time, with the fence
// re-drawn around them rather than opened.
//
// The reasoning that kept them out is preserved in what replaced it: there is
// still no free-text coordinate input anywhere. The picker writes numbers it
// derived from a map click, a search result or a GPS fix, and this schema then
// re-derives every guarantee from scratch, because a client-side picker is a
// convenience and never a validator:
//
//   finite and in range   Rejected outright otherwise. This is also what
//                         catches the one genuinely dangerous typo, a
//                         transposed pair: every Philippine longitude exceeds
//                         116, so a swap always presents a latitude outside
//                         [-90, 90].
//   both or neither       A lat without an lng is not half a location, it is a
//                         corrupt one, and `businesses_latlng_idx` indexes the
//                         pair. Enforced below at the object level, because no
//                         per-field rule can see its partner.
//   rounded               To six decimals, about 11cm. See
//                         src/lib/maps/coordinates.ts.
//
// Being outside the Philippines is NOT rejected here. That decision, and why a
// market boundary and a validity boundary must not be the same check, is
// argued at `isInsidePhilippines` in src/lib/maps/coordinates.ts.
// ===========================================================================

export const BUSINESS_NAME_MIN_LENGTH = 2;
export const BUSINESS_NAME_MAX_LENGTH = 120;
export const BUSINESS_DESCRIPTION_MAX_LENGTH = 2000;
export const CONTACT_FIELD_MAX_LENGTH = 200;
export const ADDRESS_FIELD_MAX_LENGTH = 200;
export const POSTAL_CODE_MAX_LENGTH = 20;

/** `src/lib/hours.ts`'s HH:MM shape, so what is saved is what that renderer reads. */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === undefined || value === "" ? null : value));

const optionalUrl = z
  .string()
  .trim()
  .max(CONTACT_FIELD_MAX_LENGTH)
  .optional()
  .transform((value) => (value === undefined || value === "" ? null : value))
  .refine((value) => value === null || /^https?:\/\/\S+$/.test(value), {
    message: "Links must start with http:// or https://",
  });

const optionalEmail = z
  .string()
  .trim()
  .max(CONTACT_FIELD_MAX_LENGTH)
  .optional()
  .transform((value) => (value === undefined || value === "" ? null : value))
  .refine((value) => value === null || z.email().safeParse(value).success, {
    message: "Enter a valid email address",
  });

/**
 * One weekday. `closed` days keep their open/close strings so a merchant who
 * toggles a day shut and back open does not lose the times they had typed,
 * matching doc 32 section 4's editor description.
 */
export const openingHoursEntrySchema = z.strictObject({
  day: z.number().int().min(1).max(7),
  open: z.string().regex(HHMM, "Use a 24-hour time like 09:00"),
  close: z.string().regex(HHMM, "Use a 24-hour time like 21:00"),
  closed: z.boolean(),
});
export type OpeningHoursEntry = z.infer<typeof openingHoursEntrySchema>;

/**
 * Overnight windows are legal (doc 32 section 4: "close < open renders 'until
 * 02:00 +1'"), so no ordering check. Days must be unique: two rows for Tuesday
 * would make `formatHoursSummary` pick whichever came first, silently.
 */
export const openingHoursSchema = z
  .array(openingHoursEntrySchema)
  .max(7)
  .superRefine((entries, ctx) => {
    const seen = new Set<number>();
    for (const entry of entries) {
      if (seen.has(entry.day)) {
        ctx.addIssue({ code: "custom", message: "Each day can only appear once." });
        return;
      }
      seen.add(entry.day);
    }
  });

/**
 * One coordinate: a finite number inside its range, rounded, or null.
 *
 * Optional as well as nullable so that a caller which predates the picker (the
 * onboarding wizard, an older client) simply does not mention the pin, and a
 * caller which wants to CLEAR it sends an explicit null. Absent and null both
 * arrive at the patch as null, which is what an unset pin is in the column.
 */
const optionalCoordinate = (min: number, max: number, label: string) =>
  z
    .number()
    .refine(Number.isFinite, `${label} must be a real number`)
    .min(min, `${label} must be between ${min} and ${max}`)
    .max(max, `${label} must be between ${min} and ${max}`)
    .nullable()
    .optional()
    .transform((value) => (value === undefined || value === null ? null : roundCoordinate(value)));

export const businessProfileSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(BUSINESS_NAME_MIN_LENGTH, "Your business needs a name")
    .max(BUSINESS_NAME_MAX_LENGTH, `Keep the name under ${BUSINESS_NAME_MAX_LENGTH} characters`),
  description: optionalTrimmed(BUSINESS_DESCRIPTION_MAX_LENGTH),
  phone: optionalTrimmed(CONTACT_FIELD_MAX_LENGTH),
  email: optionalEmail,
  website: optionalUrl,
  facebook: optionalUrl,
  instagram: optionalUrl,
  tiktok: optionalUrl,
  addressLine: optionalTrimmed(ADDRESS_FIELD_MAX_LENGTH),
  barangay: optionalTrimmed(ADDRESS_FIELD_MAX_LENGTH),
  postalCode: optionalTrimmed(POSTAL_CODE_MAX_LENGTH),
  lat: optionalCoordinate(LATITUDE_MIN, LATITUDE_MAX, "Latitude"),
  lng: optionalCoordinate(LONGITUDE_MIN, LONGITUDE_MAX, "Longitude"),
  openingHours: openingHoursSchema,
}).superRefine((value, ctx) => {
  // Half a pin is worse than no pin: `businesses_latlng_idx` is on the pair,
  // the nearby search reads both, and a row with one of the two set would be
  // silently invisible to it while looking populated in the admin portal.
  if ((value.lat === null) !== (value.lng === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["lat"],
      message: "A map pin needs both a latitude and a longitude.",
    });
  }
});
export type BusinessProfileInput = z.infer<typeof businessProfileSchema>;
