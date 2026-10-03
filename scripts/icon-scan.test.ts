// @vitest-environment node
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadCatalogue, readCommittedList, scanUsedIcons } from "./icon-scan";

const root = process.cwd();

describe("material symbols subset", () => {
  it("lists every icon name used in src (run `npm run gen:icons` if this fails)", () => {
    const committed = new Set(readCommittedList(root));
    const missing = scanUsedIcons(root).filter((n) => !committed.has(n));
    expect(missing, "icons used in src but absent from the subset list").toEqual([]);
  });

  it("only lists names that exist in the font", () => {
    const catalogue = loadCatalogue(root);
    expect(readCommittedList(root).filter((n) => !catalogue.has(n))).toEqual([]);
  });

  it("keeps the list sorted and deduplicated so diffs stay reviewable", () => {
    const list = readCommittedList(root);
    expect(list).toEqual([...new Set(list)].sort());
  });

  // Regression: the landing-page FAQ rendered the literal text "expand_more".
  // `expand_more` is a ligature ALIAS the font draws but that
  // material-symbols/index.d.ts does not list, so a catalogue read from the
  // .d.ts made the scanner drop it and the subset shipped without its glyph.
  it("knows alias ligatures the TypeScript list omits", () => {
    expect(loadCatalogue(root).has("expand_more")).toBe(true);
  });

  it("keeps the FAQ chevron in the subset", () => {
    expect(readCommittedList(root)).toContain("expand_more");
  });

  it("ships the subset font file", () => {
    expect(existsSync(join(root, "public/fonts/material-symbols-rounded-subset.woff2"))).toBe(true);
  });
});
