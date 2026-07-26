import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// prefers-reduced-motion, proved rather than asserted by hand.
//
// jsdom does not evaluate CSS, so a rendering test cannot show that a media
// query switches an animation off -- it would only show that a class is
// present, which is what the component tests already do. The honest place to
// prove this is the stylesheet, and the property to prove is structural:
//
//   EVERY animation this pass introduces is DEFINED INSIDE a
//   `@media (prefers-reduced-motion: no-preference)` block.
//
// That direction matters. The common way to do reduced motion is to define
// animations globally and then switch them off in a
// `prefers-reduced-motion: reduce` block, which fails open: forget one and it
// animates for everybody, including the people who asked it not to. Defining
// them only inside `no-preference` fails closed. A rule that is never written
// cannot be forgotten, and the settled, un-animated state is what a user gets
// by default.
//
// If someone later adds `.md3-something { animation: ... }` at the top level,
// this test fails and tells them where to put it instead.

const GLOBALS_CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

const NO_PREFERENCE_OPENER = "@media (prefers-reduced-motion: no-preference) {";

/**
 * The body of the no-preference media block, extracted by brace matching so
 * the nested `@keyframes` blocks inside it are handled correctly.
 */
function noPreferenceBlock(css: string): string {
  const start = css.indexOf(NO_PREFERENCE_OPENER);
  if (start === -1) return "";

  let depth = 0;
  let index = start + NO_PREFERENCE_OPENER.length - 1;

  for (; index < css.length; index += 1) {
    const char = css[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }

  return css.slice(start, index + 1);
}

describe("prefers-reduced-motion", () => {
  const block = noPreferenceBlock(GLOBALS_CSS);

  it("declares a no-preference block at all", () => {
    expect(block).not.toBe("");
  });

  it("defines every md3 keyframe set inside it", () => {
    const allKeyframes = [...GLOBALS_CSS.matchAll(/@keyframes\s+([\w-]+)/g)].map(
      (match) => match[1],
    );
    const guardedKeyframes = [...block.matchAll(/@keyframes\s+([\w-]+)/g)].map(
      (match) => match[1],
    );

    expect(allKeyframes.length).toBeGreaterThan(0);
    // Nothing is defined outside the guard.
    expect(new Set(guardedKeyframes)).toEqual(new Set(allKeyframes));
  });

  it("defines every animation declaration inside it", () => {
    const outside = GLOBALS_CSS.replace(block, "");
    // `animation:` and `animation-delay:` are the two properties that can make
    // something move on its own. Neither may appear at the top level.
    expect(outside).not.toMatch(/^\s*animation(-delay)?\s*:/m);
  });

  it("guards each motion class this pass introduces", () => {
    for (const className of [
      ".md3-enter",
      ".md3-enter-fade",
      ".md3-stagger-item",
      ".md3-linear-indeterminate-bar",
      ".md3-spinner",
    ]) {
      expect(block).toContain(className);
    }
  });

  it("keeps the stagger delay with the animation it delays", () => {
    // A stray animation-delay outside the guard would be harmless on its own
    // but is a sign the animation escaped with it.
    expect(block).toContain("animation-delay");
  });
});

describe("MD3 motion tokens", () => {
  it("defines the entering and leaving curves the spec names", () => {
    // Emphasized decelerate for things arriving, emphasized accelerate for
    // things leaving. Both exist so callers stop reaching for `ease-standard`
    // as a catch-all.
    expect(GLOBALS_CSS).toContain(
      "--ease-emphasized-decelerate: cubic-bezier(0.05, 0.7, 0.1, 1)",
    );
    expect(GLOBALS_CSS).toContain(
      "--ease-emphasized-accelerate: cubic-bezier(0.3, 0, 0.8, 0.15)",
    );
  });

  it("pairs the curves with the spec's durations", () => {
    expect(GLOBALS_CSS).toContain("--duration-enter: 400ms");
    expect(GLOBALS_CSS).toContain("--duration-exit: 200ms");
    expect(GLOBALS_CSS).toContain("--duration-standard: 300ms");
    expect(GLOBALS_CSS).toContain("--duration-emphasized: 500ms");
  });

  it("uses the entering curve for entering elements", () => {
    const block = noPreferenceBlock(GLOBALS_CSS);
    const enterRule = block.slice(block.indexOf(".md3-enter {"));

    expect(enterRule).toContain("var(--ease-emphasized-decelerate)");
  });
});
