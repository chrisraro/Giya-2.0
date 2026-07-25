// Presentation helpers for `profiles.display_name`.
//
// The column is a single free-text field: consumers sign up with anything from
// "Ana" to "Ana Marie Dela Cruz" to a padded, double-spaced mess pasted out of
// another app. The home greeting wants one short name and the profile avatar
// wants at most two letters, so both derivations live here as pure functions
// rather than inline in a page, which is what lets them be tested against the
// awkward inputs (empty, whitespace-only, one name, four names) that a
// NOT NULL text column happily accepts.

function nameParts(displayName: string | null | undefined): string[] {
  return (displayName ?? "").trim().split(/\s+/).filter(Boolean);
}

/**
 * The first word of a display name, for the greeting. Returns "" when there is
 * nothing usable, and callers must render the greeting without a name in that
 * case rather than printing a placeholder person.
 */
export function firstNameFrom(displayName: string | null | undefined): string {
  return nameParts(displayName)[0] ?? "";
}

/**
 * Up to two uppercase initials: first and last word, so "Ana Marie Dela Cruz"
 * gives "AC" and "Ana" gives "A". Returns "" when there is nothing usable;
 * the profile avatar substitutes its own fallback rather than showing a blank
 * circle.
 */
export function initialsFrom(displayName: string | null | undefined): string {
  const parts = nameParts(displayName);
  if (parts.length === 0) return "";

  const first = parts[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

/** The local part of an email address, used only as a last-resort name. */
export function emailLocalPart(email: string | null | undefined): string {
  return (email ?? "").split("@")[0] ?? "";
}
