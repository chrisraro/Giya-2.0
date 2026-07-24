import { describe, it, expect } from "vitest";
import { getSafeRedirect } from "./safe-redirect";

describe("getSafeRedirect", () => {
  it("returns an internal path unchanged", () => {
    expect(getSafeRedirect("/business/dashboard", "/home")).toBe("/business/dashboard");
  });

  it("falls back when next is missing", () => {
    expect(getSafeRedirect(null, "/home")).toBe("/home");
    expect(getSafeRedirect(undefined, "/home")).toBe("/home");
    expect(getSafeRedirect("", "/home")).toBe("/home");
  });

  it("falls back for protocol-relative targets (open-redirect risk)", () => {
    expect(getSafeRedirect("//evil.com", "/home")).toBe("/home");
    expect(getSafeRedirect("//evil.com/path", "/home")).toBe("/home");
  });

  it("falls back for absolute URLs that do not start with a single slash", () => {
    expect(getSafeRedirect("https://evil.com", "/home")).toBe("/home");
    expect(getSafeRedirect("evil.com", "/home")).toBe("/home");
  });

  it("keeps query strings on internal paths", () => {
    expect(getSafeRedirect("/onboarding?step=2", "/home")).toBe("/onboarding?step=2");
  });
});
