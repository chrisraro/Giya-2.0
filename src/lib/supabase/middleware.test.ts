import { beforeAll, describe, expect, it, vi } from "vitest";

// `./middleware` imports `@/lib/env`, which throws at module-evaluation time
// if the required NEXT_PUBLIC_* vars aren't set (see env.test.ts). Stub them
// before the dynamic import so evaluation succeeds regardless of the host
// shell's environment.
let toBizClaims: (typeof import("./middleware"))["toBizClaims"];

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");
  ({ toBizClaims } = await import("./middleware"));
});

describe("toBizClaims", () => {
  it("extracts a non-empty biz map", () => {
    expect(toBizClaims({ biz: { "biz-1": "owner" } })).toEqual({
      biz: { "biz-1": "owner" },
    });
  });

  it("extracts biz_overflow", () => {
    expect(toBizClaims({ biz_overflow: true })).toEqual({ biz_overflow: true });
  });

  it("extracts both biz and biz_overflow together", () => {
    expect(toBizClaims({ biz: { "biz-1": "staff" }, biz_overflow: false })).toEqual({
      biz: { "biz-1": "staff" },
      biz_overflow: false,
    });
  });

  it("returns an empty object for undefined app_metadata", () => {
    expect(toBizClaims(undefined)).toEqual({});
  });

  it("returns an empty object for null app_metadata", () => {
    expect(toBizClaims(null)).toEqual({});
  });

  it("returns an empty object when app_metadata has no biz claims", () => {
    expect(toBizClaims({ provider: "email", providers: ["email"] })).toEqual({});
  });

  it("ignores a non-object biz value rather than throwing", () => {
    expect(toBizClaims({ biz: "not-an-object" })).toEqual({});
  });

  it("ignores a non-boolean biz_overflow value rather than throwing", () => {
    expect(toBizClaims({ biz_overflow: "yes" })).toEqual({});
  });

  it("returns an empty object for non-object input", () => {
    expect(toBizClaims("a-jwt-string")).toEqual({});
  });
});
