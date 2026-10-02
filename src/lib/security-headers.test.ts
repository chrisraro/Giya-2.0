import { describe, expect, it } from "vitest";

import { buildCsp, buildSecurityHeaders } from "./security-headers";

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abcd1234.supabase.co",
  SENTRY_DSN: "https://pub@o123.ingest.us.sentry.io/456",
};

function header(name: string, env = ENV): string | undefined {
  return buildSecurityHeaders(env).find((h) => h.key.toLowerCase() === name.toLowerCase())?.value;
}

describe("buildSecurityHeaders", () => {
  it("blocks framing both ways (doc 15: clickjacking on admin/scanner/portal)", () => {
    expect(header("X-Frame-Options")).toBe("DENY");
    expect(header("Content-Security-Policy-Report-Only")).toContain("frame-ancestors 'none'");
  });

  it("sets the static hardening headers", () => {
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains; preload");
  });

  it("ships the CSP as report-only, never enforcing, until the audit window closes", () => {
    expect(header("Content-Security-Policy")).toBeUndefined();
    expect(header("Content-Security-Policy-Report-Only")).toBeTruthy();
  });

  it("allows camera and geolocation for self only, and denies microphone and payment", () => {
    const pp = header("Permissions-Policy");
    expect(pp).toContain("camera=(self)");
    expect(pp).toContain("geolocation=(self)");
    expect(pp).toContain("microphone=()");
    expect(pp).toContain("payment=()");
  });

  it("has no duplicate header keys", () => {
    const keys = buildSecurityHeaders(ENV).map((h) => h.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("buildCsp", () => {
  const csp = buildCsp(ENV);
  const directive = (name: string, value = csp) =>
    value
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `)) ?? "";

  it("defaults to self and forbids plugins and foreign bases/forms", () => {
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("base-uri")).toBe("base-uri 'self'");
    expect(directive("form-action")).toContain("'self'");
  });

  it("allows Supabase over https and wss (Realtime)", () => {
    const connect = directive("connect-src");
    expect(connect).toContain("https://abcd1234.supabase.co");
    expect(connect).toContain("wss://abcd1234.supabase.co");
    expect(directive("img-src")).toContain("https://abcd1234.supabase.co");
  });

  it("allows the Facebook SDK, page plugin frames and hCaptcha", () => {
    expect(directive("script-src")).toContain("https://connect.facebook.net");
    expect(directive("frame-src")).toContain("https://www.facebook.com");
    expect(directive("frame-src")).toContain("https://web.facebook.com");
    for (const d of ["script-src", "frame-src", "connect-src"]) {
      expect(directive(d)).toContain("https://hcaptcha.com");
      expect(directive(d)).toContain("https://*.hcaptcha.com");
    }
    expect(directive("style-src")).toContain("https://*.hcaptcha.com");
  });

  it("allows MapTiler tiles, data:/blob: images and camera blob media", () => {
    expect(directive("img-src")).toContain("https://api.maptiler.com");
    expect(directive("img-src")).toContain("data:");
    expect(directive("img-src")).toContain("blob:");
    expect(directive("media-src")).toContain("blob:");
  });

  it("allows the Sentry ingest host taken from the DSN, and omits it without a DSN", () => {
    expect(directive("connect-src")).toContain("https://o123.ingest.us.sentry.io");
    expect(buildCsp({ ...ENV, SENTRY_DSN: undefined })).not.toContain("sentry.io");
  });

  it("tolerates a malformed Supabase URL or DSN without throwing", () => {
    expect(() => buildCsp({ NEXT_PUBLIC_SUPABASE_URL: "not a url", SENTRY_DSN: "nope" })).not.toThrow();
  });

  it("keeps 'unsafe-inline' for scripts until nonces land (documented next step)", () => {
    expect(directive("script-src")).toContain("'unsafe-inline'");
    expect(directive("style-src")).toContain("'unsafe-inline'");
  });

  it("only adds unsafe-eval in development (React refresh)", () => {
    expect(directive("script-src")).not.toContain("'unsafe-eval'");
    expect(directive("script-src", buildCsp(ENV, { dev: true }))).toContain("'unsafe-eval'");
  });
});
