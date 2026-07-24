# Giya Design System & Brand Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved design system spec (`docs/superpowers/specs/2026-07-24-giya-design-system-design.md`): MD3 token layer + restyled components on a minimal Next.js 15 scaffold, logo assets, canonical design-system doc, and brand-kit board.

**Architecture:** Material 3 is the design language; implementation is Tailwind CSS v4 tokens + owned shadcn-style components (CVA + Radix patterns) in a fresh Next.js 15 App Router project. A build script generates the full MD3 color-role token set from three brand seeds. A `/design` showcase route is the living style guide and visual verification surface.

**Tech Stack:** Next.js 15 (App Router, TS strict), Tailwind CSS v4, `@material/material-color-utilities`, `geist` (Geist Sans/Mono via next/font), `next-themes`, `class-variance-authority` + `clsx` + `tailwind-merge`, `material-symbols` (rounded icon font), Vitest + Testing Library.

## Global Constraints

- **Stack is Locked** per `docs/10-architecture/11-tech-stack.md`: Next.js App Router only, Tailwind v4, no `@material/web`, no second component library, no CSS modules/styled-components.
- **Definitive color seeds** (never change without updating spec + doc in same PR): Primary Coral `#E8563F`, Secondary Teal `#00696D`, Tertiary Mango `#F2A93B`. Error = MD3 standard (hue 25, chroma 84).
- **Tokens only:** no raw hex/rgb color values anywhere in `src/` except the generated `src/styles/md3-tokens.css`.
- **Fonts:** Geist Sans (all UI text), Geist Mono (money/points figures, codes, receipt raw text). Loaded via `next/font` from the `geist` package. Never `<link>` fonts.
- **Shape rules:** buttons/chips = full radius; cards = 12px; sheets/dialogs = 28px; text fields = 4px.
- **Mango Gold usage:** tertiary tokens appear only on reward/points surfaces and the Scan FAB.
- **48px minimum touch targets** on consumer (touch) surfaces; state layers hover 8% / focus 10% / pressed 10%.
- **Both themes always:** every component works in light and dark; dark mode via `class` strategy (`next-themes`), default follows system.
- **Reduced motion:** all animation beyond subtle transitions is gated behind `prefers-reduced-motion: no-preference`.
- **Commits:** Conventional Commits, scope = feature (`feat(design-system): ...`), commit at the end of every task.
- **TypeScript:** `strict: true`, `noUncheckedIndexedAccess: true`. No `any`.
- Working directory is the repo root `c:\Users\raroc\OneDrive\Desktop\OCS\Giya 2.0` (git repo already initialized, docs committed).

---

### Task 1: Next.js 15 scaffold + Vitest

**Files:**
- Create: entire Next.js scaffold at repo root (`src/app/...`, `package.json`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`, `next.config.ts`, `.gitignore`)
- Create: `vitest.config.ts`
- Modify: `tsconfig.json` (strict flags)
- Modify: `package.json` (test scripts)

**Interfaces:**
- Produces: `@/*` import alias to `src/*`; `npm test` runs Vitest; `npm run dev` / `npm run build` work.

- [ ] **Step 1: Scaffold in place** (create-next-app tolerates existing `.git` and `docs/`)

Run:
```bash
npx create-next-app@latest . --typescript --app --tailwind --eslint --src-dir --import-alias "@/*" --use-npm --no-turbopack
```
Expected: scaffold created; `src/app/page.tsx`, `src/app/globals.css` with `@import "tailwindcss"` exist. If it refuses because of unexpected files, scaffold into a temp dir (`npx create-next-app@latest giya-tmp ...`), move all generated files to the root, delete `giya-tmp`.

- [ ] **Step 2: Harden tsconfig**

In `tsconfig.json` `compilerOptions`, ensure:
```jsonc
"strict": true,
"noUncheckedIndexedAccess": true,
"exactOptionalPropertyTypes": true
```

- [ ] **Step 3: Install test + core deps**

```bash
npm i geist next-themes class-variance-authority clsx tailwind-merge material-symbols @material/material-color-utilities
npm i -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom vite-tsconfig-paths tsx
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
```

Create `vitest.setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

Add to `package.json` scripts:
```jsonc
"test": "vitest run",
"test:watch": "vitest",
"gen:tokens": "tsx scripts/generate-md3-tokens.ts"
```

- [ ] **Step 5: Verify build and empty test run**

Run: `npm run build` → Expected: compiles successfully.
Run: `npm test` → Expected: "no test files found" exit 0 (or passes trivially).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(design-system): scaffold Next.js 15 app with Vitest"
```

---

### Task 2: MD3 token generation script

**Files:**
- Create: `scripts/generate-md3-tokens.ts`
- Create: `src/styles/md3-tokens.css` (generated, committed)
- Test: `scripts/generate-md3-tokens.test.ts`

**Interfaces:**
- Produces: `src/styles/md3-tokens.css` defining `--md-sys-color-<role>` on `:root` (light) and `.dark` (dark) for every role listed below. Later tasks reference roles by exact name: `primary, on-primary, primary-container, on-primary-container, secondary, on-secondary, secondary-container, on-secondary-container, tertiary, on-tertiary, tertiary-container, on-tertiary-container, error, on-error, error-container, on-error-container, surface, on-surface, surface-variant, on-surface-variant, surface-dim, surface-bright, surface-container-lowest, surface-container-low, surface-container, surface-container-high, surface-container-highest, outline, outline-variant, inverse-surface, inverse-on-surface, inverse-primary, scrim, shadow`.
- Produces: npm script `gen:tokens`.

- [ ] **Step 1: Write the failing test**

`scripts/generate-md3-tokens.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = () => readFileSync(join(process.cwd(), "src/styles/md3-tokens.css"), "utf8");

describe("md3-tokens.css", () => {
  it("exists and defines light scheme on :root and dark on .dark", () => {
    const c = css();
    expect(c).toContain(":root {");
    expect(c).toContain(".dark {");
  });

  it("defines every MD3 color role in both schemes", () => {
    const roles = [
      "primary","on-primary","primary-container","on-primary-container",
      "secondary","on-secondary","secondary-container","on-secondary-container",
      "tertiary","on-tertiary","tertiary-container","on-tertiary-container",
      "error","on-error","error-container","on-error-container",
      "surface","on-surface","surface-variant","on-surface-variant",
      "surface-dim","surface-bright",
      "surface-container-lowest","surface-container-low","surface-container",
      "surface-container-high","surface-container-highest",
      "outline","outline-variant",
      "inverse-surface","inverse-on-surface","inverse-primary","scrim","shadow",
    ];
    const c = css();
    for (const role of roles) {
      const hits = c.match(new RegExp(`--md-sys-color-${role}:`, "g")) ?? [];
      expect(hits.length, role).toBeGreaterThanOrEqual(2); // light + dark
    }
  });

  it("light primary is tone 40 of the coral seed palette", () => {
    // Deterministic: derived from seed #E8563F via HCT; assert format only + not the raw seed
    const m = css().match(/:root {[^}]*--md-sys-color-primary:\s*(#[0-9a-f]{6})/is);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m![1].toLowerCase()).not.toBe("#e8563f"); // tonal mapping, not raw seed
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/generate-md3-tokens.test.ts`
Expected: FAIL (file `src/styles/md3-tokens.css` does not exist).

- [ ] **Step 3: Write the generator**

`scripts/generate-md3-tokens.ts`:
```ts
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
:root {
${ROWS.map(([r, pal, l]) => line(r, pal, l)).join("\n")}
}

.dark {
${ROWS.map(([r, pal, , d]) => line(r, pal, d)).join("\n")}
}
`;

mkdirSync(join(process.cwd(), "src/styles"), { recursive: true });
writeFileSync(join(process.cwd(), "src/styles/md3-tokens.css"), css);
console.log("Wrote src/styles/md3-tokens.css");
```

- [ ] **Step 4: Generate and verify tests pass**

Run: `npm run gen:tokens` → Expected: "Wrote src/styles/md3-tokens.css".
Run: `npx vitest run scripts/generate-md3-tokens.test.ts` → Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/ src/styles/md3-tokens.css package.json
git commit -m "feat(design-system): MD3 color-role token generator from brand seeds"
```

---

### Task 3: Tailwind theme mapping, fonts, type scale, dark mode

**Files:**
- Modify: `src/app/globals.css` (full replacement below)
- Modify: `src/app/layout.tsx` (full replacement below)
- Create: `src/components/theme-provider.tsx`

**Interfaces:**
- Produces Tailwind utilities used by ALL later tasks:
  - Colors: `bg-primary`, `text-on-primary`, `bg-secondary-container`, `text-on-secondary-container`, `bg-tertiary-container`, `text-on-tertiary-container`, `bg-surface`, `text-on-surface`, `text-on-surface-variant`, `bg-surface-container` (+`-lowest/-low/-high/-highest`), `border-outline`, `border-outline-variant`, `bg-error`, `text-on-error`, etc. (every role from Task 2, kebab-case after the prefix).
  - Type scale utilities: `text-display-l|m|s`, `text-headline-l|m|s`, `text-title-l|m|s`, `text-body-l|m|s`, `text-label-l|m|s`.
  - Radii: `rounded-md3-xs` (4px), `rounded-md3-sm` (8px), `rounded-md3-md` (12px), `rounded-md3-lg` (16px), `rounded-md3-xl` (28px), `rounded-full`.
  - Motion: `ease-standard`, `ease-emphasized` easing utilities; durations via standard Tailwind (`duration-200` etc.).
  - Fonts: `font-sans` = Geist Sans, `font-mono` = Geist Mono.
- Produces: `<ThemeProvider>` wrapping the app (`next-themes`, `attribute="class"`).

- [ ] **Step 1: Replace `src/app/globals.css`**

```css
@import "tailwindcss";
@import "../styles/md3-tokens.css";

@custom-variant dark (&:where(.dark, .dark *));

@theme inline {
  /* MD3 color roles -> Tailwind color utilities */
  --color-primary: var(--md-sys-color-primary);
  --color-on-primary: var(--md-sys-color-on-primary);
  --color-primary-container: var(--md-sys-color-primary-container);
  --color-on-primary-container: var(--md-sys-color-on-primary-container);
  --color-secondary: var(--md-sys-color-secondary);
  --color-on-secondary: var(--md-sys-color-on-secondary);
  --color-secondary-container: var(--md-sys-color-secondary-container);
  --color-on-secondary-container: var(--md-sys-color-on-secondary-container);
  --color-tertiary: var(--md-sys-color-tertiary);
  --color-on-tertiary: var(--md-sys-color-on-tertiary);
  --color-tertiary-container: var(--md-sys-color-tertiary-container);
  --color-on-tertiary-container: var(--md-sys-color-on-tertiary-container);
  --color-error: var(--md-sys-color-error);
  --color-on-error: var(--md-sys-color-on-error);
  --color-error-container: var(--md-sys-color-error-container);
  --color-on-error-container: var(--md-sys-color-on-error-container);
  --color-surface: var(--md-sys-color-surface);
  --color-on-surface: var(--md-sys-color-on-surface);
  --color-surface-variant: var(--md-sys-color-surface-variant);
  --color-on-surface-variant: var(--md-sys-color-on-surface-variant);
  --color-surface-dim: var(--md-sys-color-surface-dim);
  --color-surface-bright: var(--md-sys-color-surface-bright);
  --color-surface-container-lowest: var(--md-sys-color-surface-container-lowest);
  --color-surface-container-low: var(--md-sys-color-surface-container-low);
  --color-surface-container: var(--md-sys-color-surface-container);
  --color-surface-container-high: var(--md-sys-color-surface-container-high);
  --color-surface-container-highest: var(--md-sys-color-surface-container-highest);
  --color-outline: var(--md-sys-color-outline);
  --color-outline-variant: var(--md-sys-color-outline-variant);
  --color-inverse-surface: var(--md-sys-color-inverse-surface);
  --color-inverse-on-surface: var(--md-sys-color-inverse-on-surface);
  --color-inverse-primary: var(--md-sys-color-inverse-primary);
  --color-scrim: var(--md-sys-color-scrim);
  --color-shadow: var(--md-sys-color-shadow);

  /* Shape scale */
  --radius-md3-xs: 4px;
  --radius-md3-sm: 8px;
  --radius-md3-md: 12px;
  --radius-md3-lg: 16px;
  --radius-md3-xl: 28px;

  /* Motion */
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ease-emphasized: cubic-bezier(0.05, 0.7, 0.1, 1);

  /* Fonts (variables provided by next/font in layout.tsx) */
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

/* MD3 type scale (Geist Sans) */
@utility text-display-l { font-size: 3.5625rem; line-height: 4rem; letter-spacing: -0.015625rem; font-weight: 400; }
@utility text-display-m { font-size: 2.8125rem; line-height: 3.25rem; font-weight: 400; }
@utility text-display-s { font-size: 2.25rem; line-height: 2.75rem; font-weight: 400; }
@utility text-headline-l { font-size: 2rem; line-height: 2.5rem; font-weight: 500; }
@utility text-headline-m { font-size: 1.75rem; line-height: 2.25rem; font-weight: 500; }
@utility text-headline-s { font-size: 1.5rem; line-height: 2rem; font-weight: 500; }
@utility text-title-l { font-size: 1.375rem; line-height: 1.75rem; font-weight: 500; }
@utility text-title-m { font-size: 1rem; line-height: 1.5rem; letter-spacing: 0.009375rem; font-weight: 600; }
@utility text-title-s { font-size: 0.875rem; line-height: 1.25rem; letter-spacing: 0.00625rem; font-weight: 600; }
@utility text-body-l { font-size: 1rem; line-height: 1.5rem; letter-spacing: 0.03125rem; font-weight: 400; }
@utility text-body-m { font-size: 0.875rem; line-height: 1.25rem; letter-spacing: 0.015625rem; font-weight: 400; }
@utility text-body-s { font-size: 0.75rem; line-height: 1rem; letter-spacing: 0.025rem; font-weight: 400; }
@utility text-label-l { font-size: 0.875rem; line-height: 1.25rem; letter-spacing: 0.00625rem; font-weight: 500; }
@utility text-label-m { font-size: 0.75rem; line-height: 1rem; letter-spacing: 0.03125rem; font-weight: 500; }
@utility text-label-s { font-size: 0.6875rem; line-height: 1rem; letter-spacing: 0.03125rem; font-weight: 500; }

body {
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface);
  font-family: var(--font-sans);
}

/* Material Symbols base */
.material-symbols-rounded {
  font-variation-settings: "FILL" 0, "wght" 400, "GRAD" 0, "opsz" 24;
  user-select: none;
}
.material-symbols-rounded.is-filled {
  font-variation-settings: "FILL" 1, "wght" 400, "GRAD" 0, "opsz" 24;
}
```

- [ ] **Step 2: Create `src/components/theme-provider.tsx`**

```tsx
"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
```

- [ ] **Step 3: Replace `src/app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "material-symbols/rounded.css";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

export const metadata: Metadata = {
  title: "Giya",
  description: "Turn every receipt into rewards. Giya is the loyalty and rewards app for Philippine food and retail.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 4: Smoke-check**

Replace `src/app/page.tsx` with:
```tsx
export default function Home() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-display-s text-primary">Giya</h1>
      <p className="text-body-l text-on-surface-variant">Design system foundation is live.</p>
    </main>
  );
}
```
Run: `npm run build` → Expected: compiles. Run `npm run dev`, open `http://localhost:3000`: heading renders in coral (light) and the page background is warm off-white; toggling OS dark mode flips it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(design-system): Tailwind MD3 theme mapping, Geist fonts, type scale, dark mode"
```

---

### Task 4: Button (5 MD3 variants) + `cn` utility

**Files:**
- Create: `src/lib/utils.ts`
- Create: `src/components/ui/button.tsx`
- Test: `src/components/ui/button.test.tsx`

**Interfaces:**
- Produces: `cn(...inputs: ClassValue[]): string` from `@/lib/utils`.
- Produces: `<Button variant="filled|tonal|outlined|text|elevated" size="sm|md|touch" />` (default `filled`/`md`) and exported `buttonVariants` CVA fn from `@/components/ui/button`. All later tasks import these exact names.

- [ ] **Step 1: Create `src/lib/utils.ts`**

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 2: Write the failing test**

`src/components/ui/button.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("renders filled variant by default with MD3 classes", () => {
    render(<Button>Scan receipt</Button>);
    const btn = screen.getByRole("button", { name: "Scan receipt" });
    expect(btn.className).toContain("bg-primary");
    expect(btn.className).toContain("rounded-full");
  });

  it("renders tonal variant on secondary-container", () => {
    render(<Button variant="tonal">Claim</Button>);
    expect(screen.getByRole("button").className).toContain("bg-secondary-container");
  });

  it("touch size meets 48px minimum", () => {
    render(<Button size="touch">Go</Button>);
    expect(screen.getByRole("button").className).toContain("h-12");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/components/ui/button.test.tsx`
Expected: FAIL ("Cannot find module './button'").

- [ ] **Step 4: Create `src/components/ui/button.tsx`**

```tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  [
    // base + MD3 state layer via ::after (hover 8%, pressed 10%)
    "relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-full",
    "text-label-l whitespace-nowrap select-none",
    "transition-all duration-200 ease-standard",
    "outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
    "disabled:pointer-events-none disabled:opacity-40",
    "active:scale-[0.98]",
    "after:absolute after:inset-0 after:rounded-full after:bg-current after:opacity-0 after:transition-opacity",
    "hover:after:opacity-[0.08] active:after:opacity-[0.10]",
  ],
  {
    variants: {
      variant: {
        filled: "bg-primary text-on-primary",
        tonal: "bg-secondary-container text-on-secondary-container",
        outlined: "border border-outline bg-transparent text-primary",
        text: "bg-transparent px-3 text-primary",
        elevated: "bg-surface-container-low text-primary shadow-md",
      },
      size: {
        sm: "h-8 px-4",
        md: "h-10 px-6",
        touch: "h-12 px-6", // consumer surfaces: 48px minimum
      },
    },
    defaultVariants: { variant: "filled", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";

export { Button, buttonVariants };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/components/ui/button.test.tsx` → Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/utils.ts src/components/ui/
git commit -m "feat(design-system): MD3 Button with five variants and state layers"
```

---

### Task 5: Card, TextField, Chip, Badge, Skeleton

**Files:**
- Create: `src/components/ui/card.tsx`
- Create: `src/components/ui/text-field.tsx`
- Create: `src/components/ui/chip.tsx`
- Create: `src/components/ui/badge.tsx`
- Create: `src/components/ui/skeleton.tsx`
- Test: `src/components/ui/core-components.test.tsx`

**Interfaces:**
- Consumes: `cn` from `@/lib/utils` (Task 4).
- Produces:
  - `<Card variant="filled|elevated|outlined">` (default `filled`), plus `CardHeader`, `CardTitle`, `CardContent` subcomponents.
  - `<TextField label helperText errorText id ...inputProps>` — label above input, outlined input (`rounded-md3-xs`), error state swaps outline + text to error tokens.
  - `<Chip selected onClick label icon?>` — MD3 filter/assist chip, full radius.
  - `<Badge>` — small tonal count/label badge (tertiary-container; reward language).
  - `<Skeleton className>` — pulse block using `bg-surface-container-high`.

- [ ] **Step 1: Write the failing test**

`src/components/ui/core-components.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Card } from "./card";
import { TextField } from "./text-field";
import { Chip } from "./chip";

describe("Card", () => {
  it("filled uses surface-container-highest, 12px radius", () => {
    render(<Card data-testid="c">x</Card>);
    const c = screen.getByTestId("c");
    expect(c.className).toContain("bg-surface-container-highest");
    expect(c.className).toContain("rounded-md3-md");
  });
});

describe("TextField", () => {
  it("renders label above input and helper text", () => {
    render(<TextField id="name" label="Business name" helperText="As registered with DTI" />);
    expect(screen.getByLabelText("Business name")).toBeInTheDocument();
    expect(screen.getByText("As registered with DTI")).toBeInTheDocument();
  });
  it("error state shows error text with role=alert", () => {
    render(<TextField id="tin" label="TIN" errorText="TIN is required" />);
    expect(screen.getByRole("alert")).toHaveTextContent("TIN is required");
  });
});

describe("Chip", () => {
  it("selected chip uses secondary-container", () => {
    render(<Chip label="Milk tea" selected />);
    expect(screen.getByRole("button").className).toContain("bg-secondary-container");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ui/core-components.test.tsx` → Expected: FAIL (modules not found).

- [ ] **Step 3: Create the five components**

`src/components/ui/card.tsx`:
```tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const cardVariants = cva("rounded-md3-md text-on-surface", {
  variants: {
    variant: {
      filled: "bg-surface-container-highest",
      elevated: "bg-surface-container-low shadow-md",
      outlined: "border border-outline-variant bg-surface",
    },
  },
  defaultVariants: { variant: "filled" },
});

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

export function Card({ className, variant, ...props }: CardProps) {
  return <div className={cn(cardVariants({ variant }), className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 p-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-title-m", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 pt-0 text-body-m text-on-surface-variant", className)} {...props} />;
}
```

`src/components/ui/text-field.tsx`:
```tsx
import * as React from "react";
import { cn } from "@/lib/utils";

export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  helperText?: string;
  errorText?: string;
}

export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(
  ({ id, label, helperText, errorText, className, ...props }, ref) => {
    const hasError = Boolean(errorText);
    const describedBy = hasError ? `${id}-error` : helperText ? `${id}-helper` : undefined;
    return (
      <div className="flex flex-col gap-2">
        <label htmlFor={id} className="text-label-l text-on-surface">
          {label}
        </label>
        <input
          ref={ref}
          id={id}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
          className={cn(
            "h-12 rounded-md3-xs border bg-surface px-4 text-body-l text-on-surface",
            "placeholder:text-on-surface-variant",
            "outline-none transition-colors duration-200 ease-standard",
            hasError
              ? "border-error focus:border-error focus:ring-1 focus:ring-error"
              : "border-outline focus:border-primary focus:ring-1 focus:ring-primary",
            className,
          )}
          {...props}
        />
        {hasError ? (
          <p id={`${id}-error`} role="alert" className="text-body-s text-error">
            {errorText}
          </p>
        ) : helperText ? (
          <p id={`${id}-helper`} className="text-body-s text-on-surface-variant">
            {helperText}
          </p>
        ) : null}
      </div>
    );
  },
);
TextField.displayName = "TextField";
```

`src/components/ui/chip.tsx`:
```tsx
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  selected?: boolean;
  icon?: React.ReactNode;
}

export function Chip({ label, selected = false, icon, className, ...props }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-full px-4 text-label-l",
        "transition-colors duration-200 ease-standard",
        "outline-none focus-visible:ring-2 focus-visible:ring-primary",
        selected
          ? "bg-secondary-container text-on-secondary-container"
          : "border border-outline bg-transparent text-on-surface-variant hover:bg-surface-container",
        className,
      )}
      {...props}
    >
      {icon}
      {label}
    </button>
  );
}
```

`src/components/ui/badge.tsx`:
```tsx
import * as React from "react";
import { cn } from "@/lib/utils";

/** Reward-language badge: tertiary (Mango) tokens are reserved for points/rewards. */
export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-tertiary-container px-2.5 py-0.5 font-mono text-label-m text-on-tertiary-container",
        className,
      )}
      {...props}
    />
  );
}
```

`src/components/ui/skeleton.tsx`:
```tsx
import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md3-sm bg-surface-container-high motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/ui/core-components.test.tsx` → Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/
git commit -m "feat(design-system): MD3 Card, TextField, Chip, Badge, Skeleton"
```

---

### Task 6: Consumer shell — bottom nav + Scan FAB + manifest

**Files:**
- Create: `src/components/shell/bottom-nav.tsx`
- Create: `src/app/(consumer)/layout.tsx`
- Create: `src/app/(consumer)/home/page.tsx`, `src/app/(consumer)/wallet/page.tsx`, `src/app/(consumer)/rewards/page.tsx`, `src/app/(consumer)/profile/page.tsx`, `src/app/(consumer)/scan/page.tsx` (placeholders)
- Create: `src/app/manifest.ts`
- Test: `src/components/shell/bottom-nav.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 4).
- Produces: `<BottomNav />` — 5 slots (Home, Wallet, center Scan FAB, Rewards, Profile), fixed bottom, safe-area padding, active-route awareness via `usePathname`.

- [ ] **Step 1: Write the failing test**

`src/components/shell/bottom-nav.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/home" }));

import { BottomNav } from "./bottom-nav";

describe("BottomNav", () => {
  it("renders 4 destinations and the Scan FAB", () => {
    render(<BottomNav />);
    for (const label of ["Home", "Wallet", "Rewards", "Profile"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    const fab = screen.getByRole("link", { name: "Scan receipt" });
    expect(fab.className).toContain("bg-tertiary-container");
    expect(fab.className).toContain("size-14"); // 56px FAB
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/shell/bottom-nav.test.tsx` → Expected: FAIL (module not found).

- [ ] **Step 3: Create `src/components/shell/bottom-nav.tsx`**

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const DESTINATIONS = [
  { href: "/home", label: "Home", icon: "home" },
  { href: "/wallet", label: "Wallet", icon: "account_balance_wallet" },
  { href: "/rewards", label: "Rewards", icon: "redeem" },
  { href: "/profile", label: "Profile", icon: "person" },
] as const;

function NavItem({ href, label, icon }: (typeof DESTINATIONS)[number]) {
  const active = usePathname().startsWith(href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className="flex min-w-16 flex-col items-center gap-1 py-2 outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span
        className={cn(
          "flex h-8 w-14 items-center justify-center rounded-full transition-colors duration-200 ease-standard",
          active && "bg-primary-container",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "material-symbols-rounded",
            active ? "is-filled text-on-primary-container" : "text-on-surface-variant",
          )}
        >
          {icon}
        </span>
      </span>
      <span className={cn("text-label-m", active ? "text-on-surface" : "text-on-surface-variant")}>
        {label}
      </span>
    </Link>
  );
}

export function BottomNav() {
  const [first, second, third, fourth] = DESTINATIONS;
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-outline-variant bg-surface-container pb-[env(safe-area-inset-bottom)]"
    >
      <div className="mx-auto flex max-w-md items-center justify-between px-2">
        <NavItem {...first} />
        <NavItem {...second} />
        <Link
          href="/scan"
          aria-label="Scan receipt"
          className={cn(
            "flex size-14 -translate-y-3 items-center justify-center rounded-md3-lg",
            "bg-tertiary-container text-on-tertiary-container shadow-lg",
            "transition-transform duration-200 ease-emphasized active:scale-95",
            "outline-none focus-visible:ring-2 focus-visible:ring-primary",
          )}
        >
          <span aria-hidden className="material-symbols-rounded">document_scanner</span>
        </Link>
        <NavItem {...third} />
        <NavItem {...fourth} />
      </div>
    </nav>
  );
}
```

- [ ] **Step 4: Consumer layout + placeholder pages**

`src/app/(consumer)/layout.tsx`:
```tsx
import { BottomNav } from "@/components/shell/bottom-nav";

export default function ConsumerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface pb-24">
      {children}
      <BottomNav />
    </div>
  );
}
```

Each placeholder page (`home`, `wallet`, `rewards`, `profile`, `scan`) follows this pattern (title swapped per page):
```tsx
export default function HomePage() {
  return (
    <main className="mx-auto max-w-md px-4 pt-6">
      <h1 className="text-headline-m">Home</h1>
      <p className="mt-2 text-body-m text-on-surface-variant">Coming soon.</p>
    </main>
  );
}
```

`src/app/manifest.ts` (theme colors: copy the exact generated values of `--md-sys-color-surface` light from `src/styles/md3-tokens.css`; the generated file is the one sanctioned source of raw hex):
```ts
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
```

- [ ] **Step 5: Run tests + visual check**

Run: `npx vitest run src/components/shell/bottom-nav.test.tsx` → Expected: PASS.
Run: `npm run dev`, open `/home` at mobile viewport: bottom nav with mango Scan FAB center-docked, active pill on Home, all targets ≥48px tall.

- [ ] **Step 6: Commit**

```bash
git add src/components/shell/ src/app/
git commit -m "feat(design-system): consumer shell with bottom nav and Scan FAB"
```

---

### Task 7: Logo SVG assets + Logo component

**Files:**
- Create: `public/brand/mark.svg`, `public/brand/wordmark.svg`, `public/brand/lockup.svg`, `public/brand/stamp.svg`, `public/brand/icon.svg`, `public/brand/icon-maskable.svg`, `public/brand/README.md`
- Create: `src/components/brand/logo.tsx`
- Modify: `src/app/layout.tsx` (favicon via metadata icons)

**Interfaces:**
- Produces: `<Logo variant="mark|wordmark|lockup|stamp" className>` rendering inline SVG in `currentColor` (so tokens color it).

- [ ] **Step 1: Create the mark**

The mark: geometric "G" ring whose counter forms a NE-pointing compass needle. `public/brand/mark.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <!-- G ring: open at the east, crossbar into center -->
  <path d="M52.5 20.5A24 24 0 1 0 56 32v-1.5H38" stroke="currentColor" stroke-width="9" stroke-linecap="round"/>
  <!-- Compass needle pointing north-east inside the counter -->
  <path d="M45 15 L31.5 22.5 L28 34 L41.5 26.5 Z" fill="currentColor"/>
</svg>
```
`icon.svg` = mark on `#e8563f`-toned rounded square? No: icons must be self-contained files; they may embed the two generated container hexes copied from `md3-tokens.css` (`primary-container` light for background, `on-primary-container` for the mark). `public/brand/icon.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="COPY_PRIMARY_CONTAINER_HEX_FROM_md3-tokens.css"/>
  <g transform="translate(8 8) scale(0.75)" fill="none">
    <path d="M52.5 20.5A24 24 0 1 0 56 32v-1.5H38" stroke="COPY_ON_PRIMARY_CONTAINER_HEX" stroke-width="9" stroke-linecap="round"/>
    <path d="M45 15 L31.5 22.5 L28 34 L41.5 26.5 Z" fill="COPY_ON_PRIMARY_CONTAINER_HEX"/>
  </g>
</svg>
```
(Replace the two COPY_* placeholders with the actual light-scheme values from the generated `md3-tokens.css` — these two files are brand assets, exempt from the token-only lint which covers `src/` only.)
`icon-maskable.svg`: same as `icon.svg` but `rx="0"` and the inner group scaled to 60% centered (safe zone).
`wordmark.svg`: the word "giya" set in lowercase Geist Sans converted to outlines is not practical by hand; instead render text with the system fallback stack and document that final outline conversion happens at brand-board time:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 64">
  <text x="0" y="44" font-family="Geist, 'Geist Sans', system-ui, sans-serif" font-size="44" font-weight="600" letter-spacing="-1" fill="currentColor">giya</text>
</svg>
```
`lockup.svg`: mark (scaled 0.75, translated) + wordmark text side by side in one viewBox `0 0 232 64`.
`stamp.svg`: mark centered in a `circle` outline (`r="30"`, `stroke-width="3"`, dashed `stroke-dasharray="4 6"`).

- [ ] **Step 2: Create `src/components/brand/logo.tsx`**

Inline the mark path as a React component (single source of truth for in-app rendering):
```tsx
import { cn } from "@/lib/utils";

const MARK = (
  <>
    <path d="M52.5 20.5A24 24 0 1 0 56 32v-1.5H38" stroke="currentColor" strokeWidth="9" strokeLinecap="round" fill="none" />
    <path d="M45 15 L31.5 22.5 L28 34 L41.5 26.5 Z" fill="currentColor" />
  </>
);

export function Logo({
  variant = "mark",
  className,
}: {
  variant?: "mark" | "wordmark" | "lockup" | "stamp";
  className?: string;
}) {
  if (variant === "mark") {
    return (
      <svg viewBox="0 0 64 64" className={cn("size-8", className)} aria-label="Giya" role="img">
        {MARK}
      </svg>
    );
  }
  if (variant === "stamp") {
    return (
      <svg viewBox="0 0 72 72" className={cn("size-10", className)} aria-label="Giya stamp" role="img">
        <circle cx="36" cy="36" r="30" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="4 6" />
        <g transform="translate(14 14) scale(0.7)">{MARK}</g>
      </svg>
    );
  }
  // wordmark / lockup
  return (
    <span className={cn("inline-flex items-center gap-2", className)} aria-label="Giya">
      {variant === "lockup" && (
        <svg viewBox="0 0 64 64" className="size-8" aria-hidden>
          {MARK}
        </svg>
      )}
      <span className="text-title-l font-semibold tracking-tight lowercase">giya</span>
    </span>
  );
}
```

- [ ] **Step 3: Wire favicon + write `public/brand/README.md`**

In `src/app/layout.tsx` metadata add:
```ts
icons: { icon: "/brand/icon.svg" },
```
`public/brand/README.md` documents: construction (circle grid, 45-degree needle axis), the four sanctioned lockups, color rules (mark renders in `currentColor`; icon files embed generated container hexes; never introduce new colors), and the outline-conversion note for the wordmark.

- [ ] **Step 4: Verify**

Run: `npm run dev`, check favicon renders; add `<Logo variant="lockup" />` temporarily to `/home` and confirm mark + wordmark render in `text-primary` when wrapped with that class. Remove the temporary usage or keep it as the home header brand row.

- [ ] **Step 5: Commit**

```bash
git add public/brand/ src/components/brand/ src/app/layout.tsx
git commit -m "feat(design-system): Giya compass-G logo assets and Logo component"
```

---

### Task 8: `/design` showcase route (living style guide)

**Files:**
- Create: `src/app/design/page.tsx`
- Create: `src/components/design/theme-toggle.tsx`

**Interfaces:**
- Consumes: every component from Tasks 4-7, type-scale and color utilities from Task 3.
- Produces: `/design` route rendering: color-role swatch grid (both container tiers), full type ramp, all Button variants x sizes, Card variants, TextField states (default/helper/error/disabled), Chips, Badge, Skeleton, Logo lockups, and a theme toggle.

- [ ] **Step 1: Create `src/components/design/theme-toggle.tsx`**

```tsx
"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <Button variant="tonal" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
      <span aria-hidden className="material-symbols-rounded">
        {resolvedTheme === "dark" ? "light_mode" : "dark_mode"}
      </span>
      {resolvedTheme === "dark" ? "Light" : "Dark"}
    </Button>
  );
}
```

- [ ] **Step 2: Create `src/app/design/page.tsx`**

```tsx
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TextField } from "@/components/ui/text-field";
import { Chip } from "@/components/ui/chip";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/design/theme-toggle";

const COLOR_ROLES = [
  "primary","on-primary","primary-container","on-primary-container",
  "secondary","on-secondary","secondary-container","on-secondary-container",
  "tertiary","on-tertiary","tertiary-container","on-tertiary-container",
  "error","error-container","surface","surface-container-lowest","surface-container-low",
  "surface-container","surface-container-high","surface-container-highest",
  "outline","outline-variant",
];

const TYPE_RAMP = [
  ["text-display-l", "Display L"], ["text-display-m", "Display M"], ["text-display-s", "Display S"],
  ["text-headline-l", "Headline L"], ["text-headline-m", "Headline M"], ["text-headline-s", "Headline S"],
  ["text-title-l", "Title L"], ["text-title-m", "Title M"], ["text-title-s", "Title S"],
  ["text-body-l", "Body L"], ["text-body-m", "Body M"], ["text-body-s", "Body S"],
  ["text-label-l", "Label L"], ["text-label-m", "Label M"], ["text-label-s", "Label S"],
] as const;

export default function DesignPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-12 px-4 py-10">
      <header className="flex items-center justify-between">
        <Logo variant="lockup" className="text-primary" />
        <ThemeToggle />
      </header>

      <section className="space-y-4">
        <h2 className="text-headline-s">Color roles</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {COLOR_ROLES.map((role) => (
            <div key={role} className="overflow-hidden rounded-md3-sm border border-outline-variant">
              <div className="h-12" style={{ background: `var(--md-sys-color-${role})` }} />
              <p className="px-2 py-1 font-mono text-label-s text-on-surface-variant">{role}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-headline-s">Type ramp (Geist Sans)</h2>
        {TYPE_RAMP.map(([cls, name]) => (
          <p key={cls} className={cls}>{name}. Every receipt counts.</p>
        ))}
        <p className="font-mono text-body-m">Geist Mono: PHP 1,250.00 = 125 pts</p>
      </section>

      <section className="space-y-4">
        <h2 className="text-headline-s">Buttons</h2>
        <div className="flex flex-wrap gap-3">
          <Button>Filled</Button>
          <Button variant="tonal">Tonal</Button>
          <Button variant="outlined">Outlined</Button>
          <Button variant="text">Text</Button>
          <Button variant="elevated">Elevated</Button>
          <Button size="touch">Touch 48px</Button>
          <Button disabled>Disabled</Button>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {(["filled", "elevated", "outlined"] as const).map((v) => (
          <Card key={v} variant={v}>
            <CardHeader><CardTitle>{v} card</CardTitle></CardHeader>
            <CardContent>Loyalty made simple for every tindahan.</CardContent>
          </Card>
        ))}
      </section>

      <section className="max-w-sm space-y-4">
        <h2 className="text-headline-s">Text fields</h2>
        <TextField id="d1" label="Business name" placeholder="Kape Diaria" helperText="As registered with DTI" />
        <TextField id="d2" label="TIN" errorText="TIN is required" />
        <TextField id="d3" label="Disabled" disabled placeholder="Not editable" />
      </section>

      <section className="space-y-4">
        <h2 className="text-headline-s">Chips, badge, skeleton, stamp</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Chip label="Milk tea" selected />
          <Chip label="Coffee" />
          <Badge>+120 pts</Badge>
          <Skeleton className="h-8 w-24" />
          <Logo variant="stamp" className="text-tertiary" />
        </div>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Verify visually in both themes**

Run: `npm run dev`, open `/design`. Check: swatch grid renders distinct tonal tiers; toggle theme; confirm hierarchy holds in dark; buttons show hover/pressed state layers; mango appears only on Badge, stamp, and (from Task 6) the Scan FAB.

Run: `npm run build` → Expected: compiles. Run `npm test` → Expected: all suites PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/design/ src/components/design/
git commit -m "feat(design-system): /design living style guide"
```

---

### Task 9: ESLint token guard

**Files:**
- Modify: `eslint.config.mjs`
- Test: manual lint run (rule verification below)

**Interfaces:**
- Produces: lint error on any raw hex color literal in `src/**/*.{ts,tsx}`.

- [ ] **Step 1: Add the rule**

In `eslint.config.mjs`, append a config object to the exported array:
```js
{
  files: ["src/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector: "Literal[value=/#[0-9a-fA-F]{3,8}\\b/]",
        message:
          "Raw hex colors are banned in src/. Use MD3 tokens (docs/10-architecture/16-design-system.md).",
      },
      {
        selector: "TemplateElement[value.raw=/#[0-9a-fA-F]{6}\\b/]",
        message:
          "Raw hex colors are banned in src/. Use MD3 tokens (docs/10-architecture/16-design-system.md).",
      },
    ],
  },
},
```

- [ ] **Step 2: Verify the rule fires**

Add `const bad = "#ff0000";` temporarily to `src/lib/utils.ts`. Run: `npm run lint` → Expected: error with the token message. Remove the line. Run `npm run lint` again → Expected: clean (note: `src/app/manifest.ts` reads hex from the generated CSS at runtime, it contains no hex literal, so it passes).

- [ ] **Step 3: Commit**

```bash
git add eslint.config.mjs
git commit -m "feat(design-system): lint rule banning raw hex colors in src"
```

---

### Task 10: Canonical doc `16-design-system.md` + docs index + DoD

**Files:**
- Create: `docs/10-architecture/16-design-system.md`
- Modify: `docs/README.md` (index table row)
- Modify: `docs/10-architecture/14-development-standards.md` (DoD additions)

**Interfaces:**
- Produces: the foundation doc all module/UI work defers to.

- [ ] **Step 1: Write `docs/10-architecture/16-design-system.md`**

Content (write exactly this, it is the canonical doc):
```markdown
# 16 - Design System & Brand (Canonical)

**Status: Locked** (changes require updating this doc in the same PR as the change; seed changes additionally update the design spec).
Source spec: `docs/superpowers/specs/2026-07-24-giya-design-system-design.md`.

## Language and implementation

Material Design 3 is the design language. Implementation is Tailwind CSS v4 tokens + owned components in `src/components/ui` (shadcn-style, CVA + Radix patterns). `@material/web` is banned. One component library, one theme file, three surface profiles.

## Brand

- **Logo:** compass-G monogram ("giya" = guide); counter forms a NE compass needle. Four sanctioned lockups: full, mark-only, wordmark-only, circular stamp. Assets: `public/brand/`; in-app rendering via `<Logo />` (`src/components/brand/logo.tsx`), always `currentColor`.
- **Tagline:** "Every receipt counts."
- **Voice:** warm, plain-language, EN/Filipino friendly. No jargon in consumer copy.

## Color

Definitive seeds (build-script inputs, `scripts/generate-md3-tokens.ts`):

| Seed | Hex | Role |
|---|---|---|
| Giya Coral | `#E8563F` | primary |
| Deep Teal | `#00696D` | secondary |
| Mango Gold | `#F2A93B` | tertiary |

Full MD3 role set generated into `src/styles/md3-tokens.css` (light on `:root`, dark on `.dark`), mapped to Tailwind utilities in `globals.css`. Rules:

1. Tokens only. Raw color values in `src/` are lint-banned; the generated CSS is the single exception.
2. Only sanctioned pairs combine: `X` with `on-X`. Never arbitrary pairings.
3. **Mango is reward language**: tertiary tokens appear only on points/rewards surfaces and the Scan FAB.
4. Dividers use `outline-variant`; `outline` is reserved for meaningful boundaries (text-field borders).
5. Both themes ship with every feature; theme = `class` strategy (`next-themes`), default system.

## Typography

Geist Sans on the full MD3 scale (`text-display-l` ... `text-label-s`, defined in `globals.css`). Geist Mono only for money/points figures, codes, and receipt raw text. Loaded via `next/font` (`geist` package).

## Shape, elevation, motion, spacing

- Shape: buttons/chips `rounded-full`; cards `rounded-md3-md` (12px); sheets/dialogs `rounded-md3-xl` (28px); text fields `rounded-md3-xs` (4px).
- Elevation is tonal: `surface-container-lowest` -> `-highest` tiers carry depth. Shadows only on FAB, dialogs, menus.
- Motion: `ease-standard` / `ease-emphasized` tokens; expressive springs (Motion library) only on consumer surfaces; everything beyond subtle honors `prefers-reduced-motion`.
- Spacing: 4px base grid, 8px rhythm. 48px minimum touch targets on consumer surfaces. State layers: hover 8%, focus 10%, pressed 10%.

## Component registry (implemented)

| Component | File | Variants |
|---|---|---|
| Button | `src/components/ui/button.tsx` | filled, tonal, outlined, text, elevated; sizes sm/md/touch |
| Card | `src/components/ui/card.tsx` | filled, elevated, outlined |
| TextField | `src/components/ui/text-field.tsx` | default, helper, error, disabled (label above; error below with role=alert) |
| Chip | `src/components/ui/chip.tsx` | selected / unselected |
| Badge | `src/components/ui/badge.tsx` | reward badge (tertiary) |
| Skeleton | `src/components/ui/skeleton.tsx` | - |
| BottomNav + Scan FAB | `src/components/shell/bottom-nav.tsx` | consumer shell |
| Logo | `src/components/brand/logo.tsx` | mark, wordmark, lockup, stamp |

New components follow MD3 anatomy, live in `src/components/ui`, and are added to this table plus the `/design` showcase in the same PR.

## Surface profiles

- **Consumer PWA** (expressive): coral leads; bottom nav + center Scan FAB (compact), rail (medium+); bottom sheets for flows; springy reward moments; generous spacing; `size="touch"` buttons.
- **Business portal** (productive): teal leads; denser spacing; rail/drawer; Tremor/TanStack themed via one chart-theme file reading tokens; no expressive motion.
- **Admin portal** (utilitarian): neutral surfaces, maximum density, zero expressive motion.

## Adaptive rules

Window size classes: compact < 600px, medium 600-840px, expanded > 840px. Every screen spec declares behavior per class. Ergonomics: 48px targets with 8px gaps; primary actions in thumb zone on compact; destructive never adjacent to primary. PWA chrome: safe-area insets, `theme-color` = surface per scheme (see `src/app/manifest.ts`), maskable icons.

## Accessibility

WCAG AA (4.5:1 body, 3:1 large/UI) minimum; AAA (7:1) target on money/points figures. Skeletons (never raw spinners on portals), designed empty states, inline errors: mandatory on every data view.

## Do / Don't

- DO use `bg-primary text-on-primary` style pairs. DON'T invent pairings.
- DO put labels above inputs. DON'T use floating labels or placeholder-as-label.
- DO use tonal surfaces for depth. DON'T add shadows outside FAB/dialog/menu.
- DO gate animation behind reduced-motion. DON'T ship required-motion UX.
- DON'T use mango/tertiary outside rewards + Scan FAB.
- DON'T import a second component library or `@material/web`.
```

- [ ] **Step 2: Index it in `docs/README.md`**

In the `10-architecture` table add:
```markdown
| [16-design-system.md](10-architecture/16-design-system.md) | Brand, MD3 token system, component registry, surface profiles, adaptive rules |
```

- [ ] **Step 3: Extend DoD in `docs/10-architecture/14-development-standards.md`**

In the "Definition of Done" checklist add:
```markdown
- [ ] Design tokens only (no raw color values); component follows `16-design-system.md`
- [ ] Both themes (light/dark) checked on touched screens
```

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs(design-system): canonical 16-design-system.md, index, DoD additions"
```

---

### Task 11: Brand-kit board (Canva) — orchestrator task

**Files:**
- Create: `docs/brand/brand-board-notes.md` (board link + prompt used)

This task is executed by the orchestrating session (requires the Canva connector), not a coding subagent.

- [ ] **Step 1: Generate the board**

Use the Canva `generate-design` tool with this brief (brandkit-skill format):

> Create a premium brand-kit overview board for "giya".
> Brand strategy: category: loyalty/rewards platform for Philippine food & retail SMEs; audience: young consumers + SME owners; personality: warm, vibrant, guiding, trustworthy; core metaphor: compass/guide ("giya" = guide); logo: lowercase geometric G monogram whose negative space forms a NE-pointing compass needle.
> Layout: 3x3 grid on a dark charcoal presentation canvas, strong gutters, sparse text.
> Panels: 1 logo cover (mark + "giya" wordmark), 2 logo construction (circle grid, 45-degree needle axis), 3 digital application (mobile app bottom-nav mockup with center scan button), 4 brand essence (tagline "Every receipt counts."), 5 color system (coral #E8563F, deep teal #00696D, mango gold #F2A93B, warm neutrals), 6 typography (Geist Sans specimen, weights 400-600), 7 physical application (loyalty stamp card / receipt), 8 image direction (warm Philippine street-food and cafe scenes, dusk light), 9 system detail (points badge chips, stamp icon row).
> Style: premium, sparse, cinematic, intentional; disciplined coral/teal/mango accents on charcoal; no clutter, no generic startup gradients, minimal readable text only.

- [ ] **Step 2: Review + record**

Review the generated board against the brandkit standard (coherent palette, sparse text, no generic AI slop). Iterate once if needed. Save the Canva design link and the final prompt into `docs/brand/brand-board-notes.md`. If the Canva connector is unavailable, record that in the notes file and flag to the user; do not substitute a low-quality fallback.

- [ ] **Step 3: Commit**

```bash
git add docs/brand/
git commit -m "docs(design-system): brand-kit board notes and link"
```

---

## Final verification (after all tasks)

- [ ] `npm run lint` clean, `npm test` all green, `npm run build` succeeds.
- [ ] `/design` reviewed in light AND dark at mobile + desktop widths.
- [ ] Spec success criteria walk-through (spec section 8): doc indexed; tokens generate both schemes; registry components on showcase; consumer shell demonstrates nav/FAB/themes/touch targets; brand assets delivered.
- [ ] Final commit if any stragglers.
