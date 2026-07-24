# 16 - Design System & Brand (Canonical)

**Status: Locked** (changes require updating this doc in the same PR as the change; seed changes additionally update the design spec).
Source spec: `docs/superpowers/specs/2026-07-24-giya-design-system-design.md`.

## Language and implementation

Material Design 3 is the design language. Implementation is Tailwind CSS v4 tokens + owned components in `src/components/ui` (shadcn-style, CVA + Radix patterns). `@material/web` is banned. One component library, one theme file, three surface profiles.

## Brand

- **Logo:** compass-G monogram ("giya" = guide); counter forms a NE compass needle. Four sanctioned lockups: full, mark-only, wordmark-only, circular stamp. Assets: `public/brand/`; in-app rendering via `<Logo />` (`src/components/brand/logo.tsx`), always `currentColor`.
- **Tagline:** "Every receipt counts."
- **Brand board:** presentation board (Canva) + candidate links and touch-up notes in `docs/brand/brand-board-notes.md`.
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
