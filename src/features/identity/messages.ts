// Consumer-facing failure copy for the profile edit surface.
//
// A plain module, not part of actions.ts, for a hard reason: a `"use server"`
// file may only export async functions, so a constant cannot live there. It is
// also the right home - the form and the actions both need to say the same
// things, and a test needs to assert against them without copying strings.
//
// WHY THESE ARE CONSTANTS AND NOT `toErrorMessage(dbError)`.
//
// Routing a Postgres or Storage error straight to the alert renders the
// database's own words at a consumer:
//
//   new row violates row-level security policy for table "objects"
//   new row for relation "profiles" violates check constraint "profiles_display_name_check"
//
// That names the schema, the table and the policy, it is not a sentence anyone
// can act on, and it is against the rule that copy never accuses the person
// reading it. The detail is not lost - it goes to the server log, where the
// person who can act on it is looking.
//
// The specific messages this slice DOES surface are the ones we author: the
// display-name bounds, the unmatched city, the oversized or undecodable photo.
// Those describe a choice the consumer made and can change. An RLS refusal does
// not.

/** Any infrastructure failure while saving the name/city form. */
export const PROFILE_SAVE_FAILED = "We could not save your profile just now. Please try again.";

/** Any infrastructure failure while storing a new photo. */
export const PHOTO_SAVE_FAILED = "We could not save that photo just now. Please try again.";

/** Any infrastructure failure while taking a photo down. */
export const PHOTO_REMOVE_FAILED = "We could not remove that photo just now. Please try again.";

/**
 * The last-resort sentence for a value that carries no usable message of its
 * own. Deliberately the same string `toErrorMessage` falls back to, so the two
 * paths cannot disagree about what "we do not know what happened" sounds like.
 */
export const GENERIC_FAILURE = "Something went wrong. Please try again.";
