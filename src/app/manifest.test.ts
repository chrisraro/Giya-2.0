import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const manifest = (await import("./manifest")).default;

// THE WEB APP MANIFEST (doc 41 section 2).
//
// Giya is documented as an installable PWA, and every field here is load-
// bearing for that claim on a real Android launcher rather than decorative.
//
// A NOTE ON HOW THESE ARE ASSERTED. Every expectation below is a LITERAL, not a
// constant imported from the module under test. A manifest test that compares
// `start_url` against the same constant the manifest renders passes for the
// correct value and for a wrong one alike - it can only ever prove the module
// agrees with itself. The doc is the authority, so the doc's strings are what
// appear on the right-hand side.

const ROOT = process.cwd();

/** Width and height straight out of a PNG's IHDR chunk. */
function pngSize(path: string): { magic: string; width: number; height: number } {
  const bytes = readFileSync(join(ROOT, "public", path));
  return {
    magic: bytes.subarray(1, 4).toString("ascii"),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

type Icon = { src: string; sizes?: string; type?: string; purpose?: string };

function icons(): Icon[] {
  return (manifest().icons ?? []) as Icon[];
}

function iconFor(sizes: string, purpose: string): Icon | undefined {
  return icons().find((icon) => icon.sizes === sizes && icon.purpose === purpose);
}

describe("manifest identity", () => {
  it("uses '/' as the app id", () => {
    // The id is the install's permanent identity. "giya-pwa-v1" bakes a version
    // into it, so shipping v2 would read as a DIFFERENT app: a second icon on
    // the home screen rather than an update to the one already there.
    expect(manifest().id).toBe("/");
  });

  it("CRITICAL: starts at /?source=pwa so installs are attributable", () => {
    // This is the only signal that separates a launch from the home screen
    // from a launch in a browser tab. "/home" loses it entirely, and with it
    // every install-funnel number in doc 40.
    expect(manifest().start_url).toBe("/?source=pwa");
  });

  it("declares the standalone, portrait, en-PH shell", () => {
    expect(manifest().display).toBe("standalone");
    expect(manifest().orientation).toBe("portrait");
    expect(manifest().lang).toBe("en-PH");
  });

  it("takes its colours from the generated MD3 tokens, not from hardcoded hex", () => {
    // Read the token file directly, with the test's own regex rather than the
    // module's reader, so this compares two independent derivations of the same
    // fact instead of a value against itself.
    const css = readFileSync(join(ROOT, "src/styles/md3-tokens.css"), "utf8");
    // No `s` flag: the target is ES2017, where dotAll is a syntax error, and
    // `[^}]` already spans newlines.
    const surface = /:root, \.light \{[^}]*--md-sys-color-surface:\s*(#[0-9a-f]{6})/i.exec(css)?.[1];
    expect(surface).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest().theme_color).toBe(surface);
    expect(manifest().background_color).toBe(surface);
  });
});

describe("manifest icons", () => {
  it("CRITICAL: ships no SVG icons", () => {
    // Android launchers do not reliably honour an SVG as maskable, which is the
    // entire point of declaring the maskable purpose. An SVG here means the
    // adaptive icon silently falls back to a letterboxed square.
    for (const icon of icons()) {
      expect(icon.type).toBe("image/png");
      expect(icon.src.endsWith(".svg")).toBe(false);
    }
  });

  it("declares 192 and 512 in both 'any' and 'maskable' purposes", () => {
    expect(iconFor("192x192", "any")).toBeDefined();
    expect(iconFor("512x512", "any")).toBeDefined();
    expect(iconFor("192x192", "maskable")).toBeDefined();
    expect(iconFor("512x512", "maskable")).toBeDefined();
  });

  it("declares a monochrome icon for Android 13 themed icons", () => {
    const mono = icons().filter((icon) => icon.purpose === "monochrome");
    expect(mono.length).toBeGreaterThan(0);
    expect(mono.every((icon) => icon.type === "image/png")).toBe(true);
  });

  it("never puts two purposes in one entry", () => {
    // "any maskable" is legal syntax and a trap: a launcher that wants a
    // maskable icon takes the same bitmap and crops the glyph off the edges,
    // because a bitmap safe for one purpose is not safe for the other.
    for (const icon of icons()) {
      expect(icon.purpose).not.toMatch(/\s/);
    }
  });

  it("CRITICAL: every declared icon exists in the repo at its declared size", () => {
    // The PNGs are generated, but they are also COMMITTED. A build that depends
    // on someone having run a script is a build that ships a manifest pointing
    // at 404s, and an install prompt Chrome silently declines to show.
    expect(icons().length).toBeGreaterThan(0);
    for (const icon of icons()) {
      expect(existsSync(join(ROOT, "public", icon.src)), icon.src).toBe(true);

      const png = pngSize(icon.src);
      expect(png.magic, icon.src).toBe("PNG");

      const [width, height] = (icon.sizes ?? "").split("x").map(Number);
      expect(png.width, icon.src).toBe(width);
      expect(png.height, icon.src).toBe(height);
    }
  });
});

describe("manifest shortcuts", () => {
  it("offers exactly the two long-press shortcuts doc 41 section 2 names", () => {
    const shortcuts = manifest().shortcuts ?? [];
    expect(shortcuts.map((shortcut) => shortcut.url)).toEqual(["/scan", "/rewards"]);
    expect(shortcuts.map((shortcut) => shortcut.name)).toEqual(["Scan receipt", "My rewards"]);
  });

  it("points every shortcut at a route that exists", () => {
    // "/wallet" was a plausible-looking shortcut too. The difference between a
    // shortcut and a dead end is whether the route is on disk.
    for (const shortcut of manifest().shortcuts ?? []) {
      expect(
        existsSync(join(ROOT, "src/app/(consumer)", shortcut.url, "page.tsx")),
        shortcut.url,
      ).toBe(true);
    }
  });

  it("gives every shortcut icon a real file", () => {
    for (const shortcut of manifest().shortcuts ?? []) {
      for (const icon of shortcut.icons ?? []) {
        expect(existsSync(join(ROOT, "public", icon.src)), icon.src).toBe(true);
        expect(pngSize(icon.src).magic, icon.src).toBe("PNG");
      }
    }
  });
});
