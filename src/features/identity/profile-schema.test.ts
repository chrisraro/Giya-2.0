import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  profileEditSchema,
} from "./profile-schema";

// `profiles.display_name` carries a DATABASE-level length check. The edit form
// carries a Zod one. Those two numbers have to be the same number, and the only
// way to know they still are is to read the constraint out of the migration and
// compare - asserting "the schema rejects 81 characters" on its own passes just
// as happily when the column's bound moves to 40 and the form starts accepting
// names the database will refuse with a 23514 the consumer cannot act on.
//
// This is the constraint-3 shape: assert the AGREEMENT, not each side.

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0002_identity.sql"),
  "utf8",
);

/** The `between A and B` bound off `profiles.display_name`'s own check. */
function displayNameCheckBounds(): { min: number; max: number } {
  const match = MIGRATION.match(
    /display_name\s+text\s+not\s+null\s+check\s*\(\s*char_length\(display_name\)\s+between\s+(\d+)\s+and\s+(\d+)\s*\)/i,
  );
  if (!match) {
    throw new Error(
      "could not find the display_name check constraint in 0002_identity.sql - " +
        "if the column moved, this test must be pointed at wherever its bound now lives",
    );
  }
  return { min: Number(match[1]), max: Number(match[2]) };
}

describe("display name bounds agree with the database", () => {
  it("CRITICAL: the Zod bounds are exactly the check constraint's bounds", () => {
    const db = displayNameCheckBounds();

    expect(DISPLAY_NAME_MIN_LENGTH).toBe(db.min);
    expect(DISPLAY_NAME_MAX_LENGTH).toBe(db.max);
  });

  it("the constraint really is the 1..80 one this slice was written against", () => {
    // A second, independent pin. If someone widens BOTH the migration and the
    // constant, the assertion above still passes; this one records what the
    // reviewed number actually was.
    expect(displayNameCheckBounds()).toEqual({ min: 1, max: 80 });
  });
});

describe("profileEditSchema", () => {
  it("accepts a name exactly at the database's maximum", () => {
    const result = profileEditSchema.safeParse({
      displayName: "a".repeat(DISPLAY_NAME_MAX_LENGTH),
      cityName: null,
    });

    expect(result.success).toBe(true);
  });

  it("rejects one character past the database's maximum, before the round trip", () => {
    const result = profileEditSchema.safeParse({
      displayName: "a".repeat(DISPLAY_NAME_MAX_LENGTH + 1),
      cityName: null,
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty name, because the column is NOT NULL with a minimum of one", () => {
    const result = profileEditSchema.safeParse({ displayName: "", cityName: null });

    expect(result.success).toBe(false);
  });

  it("trims before measuring, so a padded name is not counted as long", () => {
    // "  ana  " is 7 characters raw and 3 trimmed. The database sees whatever we
    // send it, so the schema has to trim on the same side of the measurement the
    // write does.
    const result = profileEditSchema.safeParse({ displayName: "  ana  ", cityName: null });

    expect(result.success).toBe(true);
    expect(result.success && result.data.displayName).toBe("ana");
  });

  it("rejects a name that is only whitespace, which trims to nothing", () => {
    const result = profileEditSchema.safeParse({ displayName: "     ", cityName: null });

    expect(result.success).toBe(false);
  });

  it("carries a message that does not accuse the person typing", () => {
    const result = profileEditSchema.safeParse({ displayName: "", cityName: null });

    expect(result.success).toBe(false);
    const message = result.success ? "" : (result.error.issues[0]?.message ?? "");
    expect(message).not.toMatch(/invalid|you failed|error/i);
    expect(message.length).toBeGreaterThan(0);
  });

  it("treats no city as a legitimate answer", () => {
    expect(profileEditSchema.safeParse({ displayName: "Ana", cityName: null }).success).toBe(true);
  });

  it("normalises a blank city string to no city rather than looking one up", () => {
    const result = profileEditSchema.safeParse({ displayName: "Ana", cityName: "   " });

    expect(result.success).toBe(true);
    expect(result.success && result.data.cityName).toBeNull();
  });
});
