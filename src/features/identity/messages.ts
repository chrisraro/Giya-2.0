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
 * A failed READ of the four consents. Deliberately not "you have no
 * preferences": rendering a failed read as four un-ticked switches would tell
 * somebody their consents are all off and invite them to write over what is
 * really stored.
 */
export const CONSENTS_LOAD_FAILED =
  "We could not load your preferences just now. Please try again in a moment.";

/** Any infrastructure failure while saving one consent toggle. */
export const CONSENT_SAVE_FAILED = "We could not save that preference just now. Please try again.";

/** A failed READ of the device list. Never rendered as "you have no devices". */
export const DEVICES_LOAD_FAILED =
  "We could not load your devices just now. Please try again in a moment.";

/** Any infrastructure failure while removing a device. */
export const DEVICE_REMOVE_FAILED =
  "We could not remove that device just now. Please try again.";

/**
 * The last-resort sentence for a value that carries no usable message of its
 * own. Deliberately the same string `toErrorMessage` falls back to, so the two
 * paths cannot disagree about what "we do not know what happened" sounds like.
 */
export const GENERIC_FAILURE = "Something went wrong. Please try again.";

/**
 * Log the thrown value, return the consumer's sentence.
 *
 * The client mirror of `infrastructureFailure` in actions.ts, and it lives here
 * rather than in one component because every client island in this feature needs
 * it and a second copy is a second policy. It exists because that fix was
 * half-applied: RETURNED database and storage errors were mapped to copy while
 * THROWN ones went through `toErrorMessage` and rendered the framework's own
 * words - "Body exceeded 1 MB limit", "Failed to fetch", "ECONNRESET". Same
 * slice, same class of failure, two different policies.
 *
 * A throw is infrastructure by definition. Nothing that reaches a catch in a
 * form here is a choice the consumer made and could change, so there is nothing
 * for a specific message to tell them. The detail goes to the console, where a
 * developer with the session open is the one who can act on it.
 */
export function reportThrown(scope: string, thrown: unknown): string {
  console.error(`[identity] ${scope}`, thrown);
  return GENERIC_FAILURE;
}
