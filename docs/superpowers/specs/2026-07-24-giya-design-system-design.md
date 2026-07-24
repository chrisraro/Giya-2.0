# Giya Design System & Brand Identity - Design Spec

**Date:** 2026-07-24
**Status:** Approved in brainstorming; ready for implementation planning
**Owner surfaces:** Consumer PWA, Business Portal, Admin Portal (one codebase, three route groups)

## 1. Problem & Goal

The Giya docs (`docs/`) define product, architecture, schema, and modules in depth, but contain no brand identity and no design system: no palette, no typography, no logo, no component token contract, no mobile UX rules. This spec closes that gap with:

1. A brand identity (logo direction, palette, typography).
2. A brand-kit visual board.
3. A canonical design-system document (`docs/10-architecture/16-design-system.md`) that all three surfaces follow.

**Approach (approved):** Material Design 3 is adopted as the *design language* (color roles, type scale, shape, tonal elevation, motion, adaptive layout, ergonomics), implemented entirely on the locked stack: Tailwind CSS v4 tokens + restyled shadcn/ui (Radix) components. `@material/web` is NOT used (maintenance mode, SSR friction, conflicts with the Locked stack decision in `11-tech-stack.md`). This requires no ADR.

## 2. Brand Identity

### 2.1 Personality

Warm and vibrant Filipino: friendly, energetic, community-feel. Consumer-app warmth first (persona: Mia, 24, Cebu), with enough discipline that the same system reads trustworthy in the business portal (persona: Ramon, 41, Iloilo). "Giya" means "guide" in Filipino/Cebuano; guidance is the brand's core idea.

### 2.2 Logo

- **Concept:** Compass / path monogram. A geometric "G" whose counter (negative space) forms a compass needle pointing north-east: forward and up, guidance and growth.
- **Construction:** circle-grid geometry, 45-degree needle axis, reduced to survive 16px favicon through signage.
- **Wordmark:** lowercase "giya" set in the brand sans beside the mark.
- **Sanctioned lockups (4):** full lockup (mark + wordmark), mark-only (app icon, loyalty stamp), wordmark-only, circular stamp variant (used in loyalty-card stamp animations; the needle doubles as the stamp's check motif).
- **Assets:** crafted SVG, committed under `public/brand/` with construction notes. Includes maskable app-icon variants for the PWA manifest.

### 2.3 Color (MD3 seed palette)

Three seeds, each expanded through MD3 tonal-palette generation into the full role set (`primary`, `on-primary`, `primary-container`, `on-primary-container`, `surface-container-*`, `outline`, `inverse-*`, etc.) for light and dark schemes:

| Role | Name | Seed (definitive) | Job |
|---|---|---|---|
| Primary | Giya Coral | `#E8563F` | Main actions, FAB accents, active navigation, the mark |
| Secondary | Deep Teal | `#00696D` | Trust counterweight; leads in business/admin portals |
| Tertiary | Mango Gold | `#F2A93B` | Reward language ONLY: points, stars, stamps, celebrations |
| Error | MD3 standard red | (MD3 default) | Errors; never re-themed by dynamic color |

These seeds are the definitive build-script inputs. Changing a seed is a design-system change: it updates this table and `16-design-system.md` in the same PR that regenerates the tokens.

Rules:
- Neutrals derive from the coral-tinted MD3 neutral palette (warm surfaces). No pure `#000` / `#FFF`.
- Mango Gold is scarce by rule: it appears only on reward/points surfaces and the Scan FAB. Scarcity keeps it special.
- Only sanctioned MD3 pairs may be combined (`X` with `on-X`); arbitrary pairings are banned.

### 2.4 Typography

- **One family everywhere: Geist Sans**, mapped onto the full MD3 type scale (Display L/M/S, Headline L/M/S, Title L/M/S, Body L/M/S, Label L/M/S) with weight-based hierarchy, plus emphasized (heavier) variants for expressive consumer moments.
- **Geist Mono** exclusively for receipt raw text, codes (referral, redemption fallback codes), and tabular money/points figures.
- Both loaded via `next/font` (the `geist` package). No `<link>` font loading.

### 2.5 Tagline (brand-kit candidate)

"Every receipt counts."

## 3. Token Architecture

The contract is one generated token layer consumed by everything.

- **Generation:** a small build script runs the three seeds through `@material/material-color-utilities` and emits `src/styles/md3-tokens.css` containing the complete `--md-sys-color-*` set for light and dark schemes. Medium/high-contrast variants are generated behind a V1 flag. The file is committed; it regenerates only when seeds change.
- **Tailwind mapping:** Tailwind v4 `@theme` maps every role to utilities. Components write `bg-primary`, `text-on-surface-variant`, `bg-surface-container-high`; never hex, never arbitrary values where a token exists.
- **Typography tokens:** `--md-sys-typescale-*` for every scale step on Geist Sans, exposed as utilities (for example `text-headline-m`).
- **Shape tokens:** MD3 corner scale: `xs 4px / sm 8px / md 12px / lg 16px / xl 28px / full`. Rules of use: buttons and chips = full; cards = md; sheets and dialogs = xl; text fields = xs.
- **Elevation:** tonal, not shadow. The five `surface-container` tiers (lowest to highest) carry depth. Shadows appear only on FAB, dialogs, and menus.
- **Motion:** MD3 easing/duration tokens (emphasized and standard families) for transitions; named spring presets (Motion library, `motion/react`) for consumer-PWA expressive moments (stamp animation, points count-up, wallet updates). Anything beyond subtle honors `prefers-reduced-motion`.
- **Spacing:** 4dp base grid, 8dp rhythm. 48dp minimum touch target is a hard rule on touch surfaces.
- **State layers:** MD3 opacities baked into component variants: hover 8%, focus 10%, pressed 10%.

**Enforcement:** an ESLint rule bans raw hex/rgb and arbitrary color values in `src/`; the Definition-of-Done checklist (in `14-development-standards.md`) gains "tokens only; both themes checked; loading/empty/error states designed."

## 4. Component Standards

All components remain shadcn/ui owned copies in `src/components/ui`, restyled to MD3 anatomy. One library, one theme file, three surface profiles.

### 4.1 Core restyles

| Component | MD3 treatment |
|---|---|
| Button | Five variants: `filled` (primary CTA), `tonal` (secondary-container; the workhorse), `outlined`, `text`, `elevated`. Full radius, 48dp min height on touch surfaces, state layers. |
| Card | `filled` (surface-container-highest), `elevated` (container-low + level-1 shadow), `outlined` (outline-variant border). 12px radius. |
| Text field | MD3 outlined style; label above the input (no floating label, clearer for SME users); helper and error slots always present in markup. Error below input. |
| Dialog / Sheet | 28px radius. Bottom sheets are the mobile default for consumer flows (claim reward, filters). |
| Chips, Switch, Checkbox, Snackbar, Tabs, Badge, Progress | Straight MD3 anatomy on Radix primitives. |
| FAB | Consumer-only. The Scan FAB is the PWA's signature element: center-docked in the bottom nav, tertiary-container (Mango). The one place gold acts as a button. |

Dividers use `outline-variant`, never `outline` (which is reserved for meaningful boundaries such as text-field borders).

### 4.2 Surface profiles

Same tokens, different dials:

- **Consumer PWA (expressive):** springy motion, stamp/points animations, bottom nav + Scan FAB, bottom sheets, generous spacing, primary (Coral) leads.
- **Business portal (productive):** secondary (Teal) leads, denser spacing, nav rail/drawer, Tremor charts and TanStack tables themed through one chart-theme file that reads the tokens.
- **Admin portal (utilitarian):** neutral surfaces, maximum density, zero expressive motion.

### 4.3 Mandatory states

Every data view ships: skeleton loading matching final layout (no raw spinners on portals), designed empty states that indicate how to populate, inline error states. Receipt scanning uses the optimistic "pending" pattern (points animate as pending, settle on OCR approval) per `01-personas-roles.md`.

## 5. Adaptive Layout & Mobile UX

- **Window size classes** (MD3): compact < 600dp, medium 600-840dp, expanded > 840dp; mapped once to Tailwind breakpoints in the theme. Every screen spec declares behavior per class; no implicit responsive assumptions.
- **Navigation per class:** consumer PWA: bottom navigation bar with 5 slots (Home, Wallet, Scan FAB center, Rewards, Profile) on compact; navigation rail on medium+. Portals: rail (medium), standard drawer (expanded).
- **Ergonomics:** 48dp targets with 8dp gaps; primary actions in the thumb zone (bottom third) on compact; destructive actions never adjacent to primary actions.
- **PWA chrome:** edge-to-edge with safe-area insets (`env(safe-area-inset-*)`); `theme-color` meta synced to `surface` per scheme; MD3-tonal splash and maskable manifest icons; install-prompt styling per `41-pwa-offline.md`.
- **Signature flow specs:**
  - **Scanner:** full-screen immersive surface: camera, scrim, corner-bracket guide, capture, crop, then optimistic pending state animating into the wallet. Completes in under 15 seconds of user effort (vision doc requirement).
  - **Redemption QR:** full-brightness, high-contrast surface; the 5-minute token TTL is visualized as an MD3 progress ring.
- **Theming behavior:** light and dark ship day one, both generated from the same seeds; follows `prefers-color-scheme` with an in-app override.
- **Accessibility:** WCAG AA contrast (4.5:1 body, 3:1 large text/UI) minimum everywhere; AAA (7:1) target on money and points figures; all expressive animation collapses to instant state changes under `prefers-reduced-motion`.

## 6. Deliverables & Governance

### 6.1 Deliverables (implementation phase)

1. **Logo SVG assets** under `public/brand/`: mark, wordmark, four lockups, app-icon and maskable variants, construction notes.
2. **Brand-kit board:** one premium 3x3 identity board (logo cover, construction, digital application, essence/tagline, color system, typography, physical application, image direction, system detail), generated via the Canva connector. Style: dark charcoal presentation canvas, sparse text, disciplined Coral/Teal/Mango accents.
3. **Canonical doc `docs/10-architecture/16-design-system.md`:** tokens, type/shape/motion scales, component variant registry, surface profiles, adaptive rules, do/don't list, token build-script spec. Indexed in `docs/README.md` as a foundation doc so module docs defer to it.

### 6.2 Governance

- Docs are canon: any token or variant change updates `16-design-system.md` in the same PR.
- DoD checklist additions: tokens only, no raw color values, loading/empty/error states designed, both themes checked.
- ESLint token rule enforces mechanically.

## 7. Out of Scope

- No `@material/web` components; no second component library.
- No white-label per-business theming (vision doc non-goal for v1).
- No dynamic (wallpaper-derived) color; seeds are fixed brand seeds. Dynamic color is not applicable to a web PWA and is not planned.
- Marketing site / landing pages (separate effort; will consume the same brand kit).
- Actual screen-by-screen UI design for every module (module docs + implementation phase own that, governed by this system).

## 8. Success Criteria

1. `16-design-system.md` exists as a foundation doc and the docs README indexes it.
2. Token layer generates both schemes from the three seeds; zero raw color values in `src/` (lint-enforced once code exists).
3. All shadcn components used by MVP screens have MD3-restyled variants documented in the variant registry.
4. Consumer PWA shell demonstrates: bottom nav + Scan FAB, both themes, 48dp targets, reduced-motion compliance.
5. Brand assets (logo lockups, brand board) delivered and referenced from the design-system doc.
