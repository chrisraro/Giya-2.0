import type { MetadataRoute } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function tokenHex(name: string): string {
  const css = readFileSync(join(process.cwd(), "src/styles/md3-tokens.css"), "utf8");
  const m = css.match(new RegExp(`:root {[^}]*--md-sys-color-${name}:\\s*(#[0-9a-f]{6})`, "is"));
  if (!m?.[1]) throw new Error(`token ${name} missing`);
  return m[1];
}

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Giya",
    short_name: "Giya",
    description: "Turn every receipt into rewards.",
    start_url: "/home",
    display: "standalone",
    background_color: tokenHex("surface"),
    theme_color: tokenHex("surface"),
    icons: [
      { src: "/brand/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
      { src: "/brand/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
