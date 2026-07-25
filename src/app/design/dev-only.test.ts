import { describe, expect, it } from "vitest";

import { isDesignRouteEnabled } from "./dev-only";

// /design is the internal MD3 swatch board and it was PUBLICLY LIVE on the
// production deployment: middleware's matcher excludes _next, favicon and
// brand/ and nothing else. The route now gates itself on this predicate, so
// this is the unit that decides whether an internal tool is on the public
// internet.
//
// The end-to-end behaviour was verified against a real `next build` +
// `next start`: /design and /design/tokens both answer HTTP 404 with the
// app's own 404 body, and the built response contains none of the swatch
// markup (no "Color roles", no "Type ramp", no md-sys-color-* declarations).

describe("isDesignRouteEnabled", () => {
  it("allows development, which is the only environment the tool is for", () => {
    expect(isDesignRouteEnabled("development")).toBe(true);
  });

  it("CRITICAL: is an allowlist, so every non-development environment is out", () => {
    // The tempting version of this check is `!== "production"`, which would
    // have shipped the board to preview and staging deployments - the exact
    // class of mistake that put it on the internet in the first place.
    for (const nodeEnv of ["production", "test", "staging", "preview", "ci", ""]) {
      expect(isDesignRouteEnabled(nodeEnv), nodeEnv).toBe(false);
    }
  });

  it("treats an unset NODE_ENV as not development", () => {
    expect(isDesignRouteEnabled(undefined)).toBe(false);
  });
});
