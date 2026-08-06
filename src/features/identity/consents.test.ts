import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONSENT_COLUMNS, isConsentColumn } from "./consents";

// THE AGREEMENT TESTS.
//
// Three files have to agree about the four consent columns and none of them can
// see the other two:
//
//   * src/features/identity/consents.ts  - the allowlist saveConsent writes through
//   * supabase/migrations/0002_identity.sql  - the columns and their DEFAULTS
//   * supabase/migrations/0021_consumer_selfupdate_column_fence.sql - the grant
//
// Checking each side against a remembered convention passes right up until they
// drift. So the SQL is parsed here and the TypeScript is measured against it: a
// column added to CONSENT_COLUMNS that 0021 never granted would fail silently in
// production (RLS passes, the grant refuses), and a default flipped in 0002
// would silence transactional messaging for every consumer without a single
// TypeScript file changing.
//
// The expected DEFAULTS below are written as literals on purpose. Reading them
// out of the same migration the assertion parses would make the test agree with
// whatever the schema currently says, which is not an assertion at all.

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

const IDENTITY_SQL = readFileSync(join(MIGRATIONS, "0002_identity.sql"), "utf8");
const FENCE_SQL = readFileSync(join(MIGRATIONS, "0021_consumer_selfupdate_column_fence.sql"), "utf8");

/** The body of `create table public.consumers ( ... );` from 0002. */
function consumersDdl(): string {
  const start = IDENTITY_SQL.indexOf("create table public.consumers");
  if (start === -1) throw new Error("0002 has no public.consumers table");
  const end = IDENTITY_SQL.indexOf(");", start);
  if (end === -1) throw new Error("public.consumers DDL is not terminated");
  return IDENTITY_SQL.slice(start, end);
}

/** The `default <literal>` 0002 declares for one consumers column. */
function schemaDefaultOf(column: string): string {
  const match = consumersDdl().match(
    new RegExp(`^\\s*${column}\\s+boolean\\s+not null\\s+default\\s+(\\w+)`, "m"),
  );
  if (!match) throw new Error(`0002 declares no boolean default for consumers.${column}`);
  return match[1] as string;
}

/** The column names inside 0021's `grant update (...) on public.consumers`. */
function grantedConsumerColumns(): string[] {
  const match = FENCE_SQL.match(
    /grant update \(([^)]*)\) on public\.consumers to authenticated;/,
  );
  if (!match) throw new Error("0021 no longer grants update on public.consumers");
  return (match[1] as string)
    .split(",")
    .map((line) => line.replace(/--.*$/gm, "").trim())
    .filter((name) => name.length > 0);
}

describe("CONSENT_COLUMNS", () => {
  it("names exactly the four consent columns, in no other shape", () => {
    // Literals, not a re-derivation: this is the list the settings screen and
    // the server action both key off.
    expect([...CONSENT_COLUMNS]).toEqual([
      "marketing_opt_in",
      "push_enabled",
      "email_enabled",
      "gps_fraud_opt_in",
    ]);
  });

  it("CRITICAL: every column it lists is one 0021 actually granted", () => {
    // A column in this list that 0021 withheld would fail at the database with
    // an error nobody sees until a consumer's toggle silently stops sticking.
    const granted = grantedConsumerColumns();
    for (const column of CONSENT_COLUMNS) {
      expect(granted).toContain(column);
    }
  });

  it("does not reach past the fence for anything 0021 deliberately withheld", () => {
    const granted = grantedConsumerColumns();
    expect(granted).not.toContain("scan_blocked_until");
    expect(granted).not.toContain("is_suspended");
    expect(granted).not.toContain("lifetime_points_earned");
  });
});

describe("isConsentColumn", () => {
  it("accepts each of the four", () => {
    expect(isConsentColumn("marketing_opt_in")).toBe(true);
    expect(isConsentColumn("push_enabled")).toBe(true);
    expect(isConsentColumn("email_enabled")).toBe(true);
    expect(isConsentColumn("gps_fraud_opt_in")).toBe(true);
  });

  it("CRITICAL: refuses a column outside the fence", () => {
    // saveConsent builds its update payload from a caller-supplied key. Without
    // this guard a server action - a public endpoint - would let anyone name
    // their own column.
    expect(isConsentColumn("scan_blocked_until")).toBe(false);
    expect(isConsentColumn("is_suspended")).toBe(false);
    expect(isConsentColumn("city_id")).toBe(false);
    expect(isConsentColumn("")).toBe(false);
    expect(isConsentColumn(null)).toBe(false);
    expect(isConsentColumn(7)).toBe(false);
  });
});

describe("the schema defaults the settings screen must not undo", () => {
  it("CRITICAL: marketing_opt_in defaults to false (NPC Circular 2023-04)", () => {
    // Marketing consent has to be freely given and specific. A pre-ticked box
    // is not consent, and the schema is where that starts.
    expect(schemaDefaultOf("marketing_opt_in")).toBe("false");
  });

  it("CRITICAL: push_enabled defaults to true, and that is correct", () => {
    // Service notifications: a receipt was approved, points are expiring.
    // Flipping this default would silence transactional messaging for every
    // existing consumer.
    expect(schemaDefaultOf("push_enabled")).toBe("true");
  });

  it("CRITICAL: email_enabled defaults to true, and that is correct", () => {
    expect(schemaDefaultOf("email_enabled")).toBe("true");
  });

  it("CRITICAL: gps_fraud_opt_in defaults to false", () => {
    // It gates location capture on receipt submission. Nobody shares their
    // location by not having read a settings screen.
    expect(schemaDefaultOf("gps_fraud_opt_in")).toBe("false");
  });
});
