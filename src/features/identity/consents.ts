// The four consumer consent columns on public.consumers, and the allowlist the
// server action writes through.
//
// A plain module rather than part of actions.ts for the same reason messages.ts
// is one: a `"use server"` file may only export async functions, so a constant
// cannot live there. Both the settings screen and the action need this list, and
// a test needs to measure it against the SQL.
//
// WHY AN ALLOWLIST AND NOT JUST A TYPE.
//
// saveConsent builds its update payload from a key the CALLER supplies, and a
// server action is a public endpoint - the browser is not the only thing that
// can call it. A TypeScript union disappears at runtime, so without the
// predicate below `{ [key]: value }` would let anyone name their own column.
// 0021's grant is the real fence (it revoked table-level UPDATE and granted back
// exactly six columns), and this is the second one, in front of it.
//
// The list is deliberately NOT derived from the generated Database types. Those
// describe every column on the table, including `scan_blocked_until`, which is
// the one column 0021 exists to keep a consumer's hands off.

/**
 * The consents a consumer edits about themselves. Every name here is granted to
 * `authenticated` by 0021_consumer_selfupdate_column_fence.sql; consents.test.ts
 * parses that migration and proves it.
 *
 * `marketing_opt_in` is first and is handled separately by the UI. It is not a
 * notification preference: NPC Circular 2023-04 requires marketing consent to be
 * freely given, specific and separate from other consents, so it must never be
 * bundled with the three service toggles or pre-selected.
 */
export const CONSENT_COLUMNS = [
  "marketing_opt_in",
  "push_enabled",
  "email_enabled",
  "gps_fraud_opt_in",
] as const;

export type ConsentColumn = (typeof CONSENT_COLUMNS)[number];

/** The four consents as the settings screen holds them. */
export type ConsentState = Record<ConsentColumn, boolean>;

const ALLOWED = new Set<string>(CONSENT_COLUMNS);

/** True only for one of the four columns above. Runtime guard, not a cast. */
export function isConsentColumn(value: unknown): value is ConsentColumn {
  return typeof value === "string" && ALLOWED.has(value);
}
