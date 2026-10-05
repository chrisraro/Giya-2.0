import { describe, expect, it } from "vitest";

import { buildCsp, buildEnforcedCsp, buildSecurityHeaders } from "./security-headers";

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abcd1234.supabase.co",
  SENTRY_DSN: "https://pub@o123.ingest.us.sentry.io/456",
};

function header(name: string, env = ENV): string | undefined {
  return buildSecurityHeaders(env).find((h) => h.key.toLowerCase() === name.toLowerCase())?.value;
}

describe("buildSecurityHeaders", () => {
  it("restricts framing to self and the owner's portfolio via frame-ancestors, with no X-Frame-Options", () => {
    expect(header("X-Frame-Options")).toBeUndefined();
    expect(header("Content-Security-Policy")).toContain(
      "frame-ancestors 'self' https://christian-digital-portfolio.vercel.app",
    );
  });

  it("sets the static hardening headers", () => {
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains; preload");
  });

  it("enforces only the directives that cannot break a legitimate load", () => {
    expect(header("Content-Security-Policy")).toBe(
      "frame-ancestors 'self' https://christian-digital-portfolio.vercel.app; object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests",
    );
    expect(buildEnforcedCsp()).toBe(header("Content-Security-Policy"));
  });

  it("keeps the full allow-list report-only, with reporting wired to /api/csp-report", () => {
    const ro = header("Content-Security-Policy-Report-Only") ?? "";
    for (const d of ["default-src", "script-src", "style-src", "img-src", "connect-src", "frame-src", "font-src", "media-src", "worker-src"]) {
      expect(ro).toContain(`${d} `);
    }
    expect(ro).toContain("report-uri /api/csp-report");
    expect(ro).toContain("report-to csp");
    expect(header("Content-Security-Policy")).not.toContain("script-src");
  });

  it("declares the csp reporting endpoint", () => {
    expect(header("Reporting-Endpoints")).toBe('csp="/api/csp-report"');
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

  it("defaults to self and leaves the enforced directives to the enforced header", () => {
    expect(directive("default-src")).toBe("default-src 'self'");
    for (const d of ["object-src", "base-uri", "form-action", "frame-ancestors"]) {
      expect(directive(d)).toBe("");
    }
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
