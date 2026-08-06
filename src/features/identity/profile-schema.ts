import { z } from "zod";

// The shape of the consumer profile edit surface (`/profile/edit`), shared by
// the client island that renders the form and the server action that writes it.
// A plain module with no "use server" and no "use client": both sides import it,
// nothing crosses the RSC boundary.
//
// THE BOUNDS ARE NOT A DESIGN CHOICE. `profiles.display_name` is declared in
// 0002_identity.sql as:
//
//   display_name text not null check (char_length(display_name) between 1 and 80)
//
// so 1 and 80 are the database's numbers, mirrored here so the form can refuse a
// name before spending a round trip on a 23514 the consumer cannot act on.
// profile-schema.test.ts reads that constraint straight out of the migration and
// asserts these two constants equal it, because a bound that merely looks right
// is a bound nobody has checked.

/** `char_length(display_name) between THIS and DISPLAY_NAME_MAX_LENGTH` (0002). */
export const DISPLAY_NAME_MIN_LENGTH = 1;

/** `char_length(display_name) between DISPLAY_NAME_MIN_LENGTH and THIS` (0002). */
export const DISPLAY_NAME_MAX_LENGTH = 80;

/**
 * Copy rule (brief constraint 9): validation copy never accuses the person
 * typing. "Your name needs at least one character", not "invalid name".
 */
export const displayNameSchema = z
  .string()
  .trim()
  .min(DISPLAY_NAME_MIN_LENGTH, "Add a name so people know who you are.")
  .max(
    DISPLAY_NAME_MAX_LENGTH,
    `Names here fit ${DISPLAY_NAME_MAX_LENGTH} characters. Try a shorter one.`,
  );

/**
 * The city arrives as a NAME, not an id: the picker reads `ref_cities.name`
 * through the browser client (the table carries a public select policy) and the
 * server action resolves the name back to `ref_cities.id`, exactly as
 * `completeConsumerOnboarding` already does. Sending a name rather than an id
 * keeps the client from being the thing that decides which row it writes.
 *
 * An all-whitespace city collapses to null rather than being looked up: "no
 * city" is a legitimate answer here (the column is nullable and onboarding's
 * Skip path leaves it null), and " " is that answer typed clumsily, not a city
 * we should fail to find.
 */
export const cityNameSchema = z
  .string()
  .trim()
  .nullable()
  .transform((value) => (value === null || value === "" ? null : value));

export const profileEditSchema = z.object({
  displayName: displayNameSchema,
  cityName: cityNameSchema,
});

export type ProfileEditInput = z.input<typeof profileEditSchema>;
export type ProfileEditValues = z.output<typeof profileEditSchema>;
