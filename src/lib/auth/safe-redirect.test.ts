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

  // Regression: a startsWith("/") + startsWith("//") blocklist misses this.
  // Browsers (and the WHATWG URL parser) normalize backslashes to forward
  // slashes for special schemes, so "/\evil.com" starts with a single "/"
  // but still resolves to host "evil.com" during real navigation.
  it("falls back for a backslash variant of protocol-relative (resolves to a different host)", () => {
    expect(getSafeRedirect("/\\evil.com", "/home")).toBe("/home");
    expect(getSafeRedirect("/\\evil.com/path", "/home")).toBe("/home");
  });

  it("falls back for the decoded form of ?next=%2F%5Cevil.com", () => {
    // URLSearchParams.get() (used by both the login page and the callback
    // route) already decodes percent-escapes before getSafeRedirect ever
    // sees the value, so the attack surface is the decoded string below.
    const decoded = decodeURIComponent("%2F%5Cevil.com");
    expect(decoded).toBe("/\\evil.com");
    expect(getSafeRedirect(decoded, "/home")).toBe("/home");
  });

  it("preserves query string and hash together on an internal path", () => {
    expect(getSafeRedirect("/home?a=1#x", "/home")).toBe("/home?a=1#x");
  });
});
