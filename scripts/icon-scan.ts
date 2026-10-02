import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Shared by scripts/gen-icons.ts (writes the list + font) and
// scripts/icon-scan.test.ts (guards the list).
//
// Icons are ligatures, so an icon name is just text in the DOM and can reach a
// `.material-symbols-rounded` element from anywhere: a JSX child, a prop, a
// nav-config object, a Record of status -> icon. Tracing each of those is
// brittle, so we go the other way round: the font ships a closed catalogue of
// ~4k names (material-symbols/index.d.ts), and we collect every string literal
// or JSX text node in src whose whole content is one of those names. That
// over-includes the odd word that is also an icon name ("check", "error"),
// which costs a few hundred bytes, and can never under-include.

export const ICON_LIST_PATH = "scripts/material-symbols-used.txt";

const SKIP_DIRS = new Set(["node_modules", ".next", ".claude", ".git"]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
}

export function loadCatalogue(root: string): Set<string> {
  const dts = readFileSync(join(root, "node_modules/material-symbols/index.d.ts"), "utf8");
  const names = new Set<string>();
  for (const m of dts.matchAll(/^\s*"([a-z0-9_]+)",?$/gm)) names.add(m[1]!);
  return names;
}

export function scanUsedIcons(root: string): string[] {
  const catalogue = loadCatalogue(root);
  const files: string[] = [];
  walk(join(root, "src"), files);

  const used = new Set<string>();
  const literal = /["'`]([a-z0-9_]+)["'`]/g;
  // JSX text: `>` then optional whitespace, one token, whitespace, `<`.
  const jsxText = />\s*([a-z0-9_]+)\s*</g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const re of [literal, jsxText]) {
      for (const m of text.matchAll(re)) {
        const name = m[1]!;
        if (catalogue.has(name)) used.add(name);
      }
    }
  }
  return [...used].sort();
}

export function readCommittedList(root: string): string[] {
  return readFileSync(join(root, ICON_LIST_PATH), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
