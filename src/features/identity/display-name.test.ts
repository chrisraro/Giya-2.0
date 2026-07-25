import { describe, expect, it } from "vitest";

import { emailLocalPart, firstNameFrom, initialsFrom } from "./display-name";

// profiles.display_name is a single NOT NULL free-text column, so these
// functions have to survive whatever a signup form let through.

describe("firstNameFrom", () => {
  it("takes the first word of a full name", () => {
    expect(firstNameFrom("Ana Marie Dela Cruz")).toBe("Ana");
  });

  it("returns a single name unchanged", () => {
    expect(firstNameFrom("Ana")).toBe("Ana");
  });

  it("ignores surrounding and repeated whitespace", () => {
    expect(firstNameFrom("   Ana   Marie  ")).toBe("Ana");
  });

  it("returns an empty string for nothing usable", () => {
    expect(firstNameFrom("")).toBe("");
    expect(firstNameFrom("   ")).toBe("");
    expect(firstNameFrom(null)).toBe("");
    expect(firstNameFrom(undefined)).toBe("");
  });

  it("preserves the name's own casing rather than inventing a style", () => {
    expect(firstNameFrom("chris roca")).toBe("chris");
  });
});

describe("initialsFrom", () => {
  it("uses the first and last word", () => {
    expect(initialsFrom("Ana Marie Dela Cruz")).toBe("AC");
  });

  it("uses one letter for a single name", () => {
    expect(initialsFrom("Ana")).toBe("A");
  });

  it("uppercases whatever it is given", () => {
    expect(initialsFrom("chris roca")).toBe("CR");
  });

  it("never returns more than two letters", () => {
    expect(initialsFrom("Ana Marie Dela Cruz Santos").length).toBeLessThanOrEqual(2);
  });

  it("returns an empty string for nothing usable, so callers can substitute", () => {
    expect(initialsFrom("")).toBe("");
    expect(initialsFrom("   ")).toBe("");
    expect(initialsFrom(null)).toBe("");
  });
});

describe("emailLocalPart", () => {
  it("takes everything before the @", () => {
    expect(emailLocalPart("ana.cruz@example.com")).toBe("ana.cruz");
  });

  it("returns an empty string for a missing email", () => {
    expect(emailLocalPart("")).toBe("");
    expect(emailLocalPart(null)).toBe("");
  });
});
