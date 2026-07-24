import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Reads a generated MD3 color token from src/styles/md3-tokens.css (the sanctioned raw-hex source). */
export function tokenHex(name: string, scheme: "light" | "dark" = "light"): string {
  const css = readFileSync(join(process.cwd(), "src/styles/md3-tokens.css"), "utf8");
  const block = (scheme === "light" ? css.match(/:root, \.light \{[^}]*\}/) : css.match(/\.dark \{[^}]*\}/))?.[0];
  const m = block?.match(new RegExp(`--md-sys-color-${name}:\\s*(#[0-9a-f]{6})`, "i"));
  if (!m?.[1]) throw new Error(`md3 token ${name} (${scheme}) missing`);
  return m[1];
}
