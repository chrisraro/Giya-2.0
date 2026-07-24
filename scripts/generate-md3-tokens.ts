/**
 * Generates src/styles/md3-tokens.css from the three definitive Giya seeds.
 * Seed changes require updating the design spec and 16-design-system.md in the same PR.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  argbFromHex,
  hexFromArgb,
  Hct,
  TonalPalette,
} from "@material/material-color-utilities";

const SEEDS = {
  primary: "#E8563F", // Giya Coral
  secondary: "#00696D", // Deep Teal
  tertiary: "#F2A93B", // Mango Gold
} as const;

const p = {
  primary: TonalPalette.fromInt(argbFromHex(SEEDS.primary)),
  secondary: TonalPalette.fromInt(argbFromHex(SEEDS.secondary)),
  tertiary: TonalPalette.fromInt(argbFromHex(SEEDS.tertiary)),
  error: TonalPalette.fromHueAndChroma(25, 84), // MD3 standard error
  // Coral-tinted neutrals: same hue as coral, MD3 neutral chromas
  neutral: TonalPalette.fromHueAndChroma(Hct.fromInt(argbFromHex(SEEDS.primary)).hue, 4),
  neutralVariant: TonalPalette.fromHueAndChroma(Hct.fromInt(argbFromHex(SEEDS.primary)).hue, 8),
};

type Row = [role: string, palette: TonalPalette, light: number, dark: number];

const accent = (name: "primary" | "secondary" | "tertiary" | "error"): Row[] => [
  [name, p[name], 40, 80],
  [`on-${name}`, p[name], 100, 20],
  [`${name}-container`, p[name], 90, 30],
  [`on-${name}-container`, p[name], 10, 90],
];

const ROWS: Row[] = [
  ...accent("primary"),
  ...accent("secondary"),
  ...accent("tertiary"),
  ...accent("error"),
  ["surface", p.neutral, 98, 6],
  ["on-surface", p.neutral, 10, 90],
  ["surface-variant", p.neutralVariant, 90, 30],
  ["on-surface-variant", p.neutralVariant, 30, 80],
  ["surface-dim", p.neutral, 87, 6],
  ["surface-bright", p.neutral, 98, 24],
  ["surface-container-lowest", p.neutral, 100, 4],
  ["surface-container-low", p.neutral, 96, 10],
  ["surface-container", p.neutral, 94, 12],
  ["surface-container-high", p.neutral, 92, 17],
  ["surface-container-highest", p.neutral, 90, 22],
  ["outline", p.neutralVariant, 50, 60],
  ["outline-variant", p.neutralVariant, 80, 30],
  ["inverse-surface", p.neutral, 20, 90],
  ["inverse-on-surface", p.neutral, 95, 20],
  ["inverse-primary", p.primary, 80, 40],
  ["scrim", p.neutral, 0, 0],
  ["shadow", p.neutral, 0, 0],
];

const line = (role: string, palette: TonalPalette, tone: number) =>
  `  --md-sys-color-${role}: ${hexFromArgb(palette.tone(tone)).toLowerCase()};`;

const css = `/* GENERATED FILE - do not edit. Run \`npm run gen:tokens\`. Seeds: coral ${SEEDS.primary}, teal ${SEEDS.secondary}, mango ${SEEDS.tertiary}. */
:root, .light {
${ROWS.map(([r, pal, l]) => line(r, pal, l)).join("\n")}
}

.dark {
${ROWS.map(([r, pal, , d]) => line(r, pal, d)).join("\n")}
}
`;

mkdirSync(join(process.cwd(), "src/styles"), { recursive: true });
writeFileSync(join(process.cwd(), "src/styles/md3-tokens.css"), css);
console.log("Wrote src/styles/md3-tokens.css");
