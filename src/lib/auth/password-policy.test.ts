import { describe, expect, it } from "vitest";

import { passwordSchema } from "./password-policy";

describe("passwordSchema (doc 15)", () => {
  it("rejects 7 characters", () => {
    expect(passwordSchema.safeParse("a".repeat(7)).success).toBe(false);
  });
  it("accepts 8 characters", () => {
    expect(passwordSchema.safeParse("a".repeat(8)).success).toBe(true);
  });
  it("accepts 72 and rejects 73 characters", () => {
    expect(passwordSchema.safeParse("a".repeat(72)).success).toBe(true);
    expect(passwordSchema.safeParse("a".repeat(73)).success).toBe(false);
  });
  it("rejects empty and non-strings", () => {
    expect(passwordSchema.safeParse("").success).toBe(false);
    expect(passwordSchema.safeParse(undefined).success).toBe(false);
    expect(passwordSchema.safeParse(12345678).success).toBe(false);
  });
});
