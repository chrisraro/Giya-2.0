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

The full scale is registered in `cn()`'s `tailwind-merge` config (`src/lib/utils.ts`) as an extension of the built-in `font-size` class group. Without this, `tailwind-merge` does not recognize these custom `@utility` classes and falls back to treating them as unrecognized `text-*` classes, which land in its `text-color` group — the same group as `text-on-surface` and friends — so composing a type-scale class with a color class through `cn()` silently deletes the size class and keeps only the color. `src/lib/utils.test.ts` pins that every scale step survives alongside a color class.

## Shape, elevation, motion, spacing

- Shape: buttons/chips `rounded-full`; cards `rounded-md3-md` (12px); sheets/dialogs `rounded-md3-xl` (28px); text fields `rounded-md3-xs` (4px).
- Elevation is tonal: `surface-container-lowest` -> `-highest` tiers carry depth. Shadows only on FAB, dialogs, menus.
- Spacing: 4px base grid, 8px rhythm. 48px minimum touch targets on consumer surfaces. State layers: hover 8%, focus 10%, pressed 10%.

### Motion tokens

MD3 gives every easing a symmetric curve plus an enter (decelerate) and an exit (accelerate) variant. All are defined in `globals.css`:

| Token | Curve | Duration token | Use |
|---|---|---|---|
| `--ease-emphasized` | `0.05, 0.7, 0.1, 1` | `--duration-emphasized` 500ms | Pre-existing name, carries the DECELERATE curve. Kept for compatibility; prefer the explicit names below in new work. |
| `--ease-emphasized-decelerate` | `0.05, 0.7, 0.1, 1` | `--duration-enter` 400ms | Elements ENTERING the screen |
| `--ease-emphasized-accelerate` | `0.3, 0, 0.8, 0.15` | `--duration-exit` 200ms | Elements LEAVING the screen |
| `--ease-standard` | `0.2, 0, 0, 1` | `--duration-standard` 300ms | Utility transitions (colour, state layers) |
| `--ease-standard-decelerate` | `0, 0, 0, 1` | `--duration-standard` | Utility enter |
| `--ease-standard-accelerate` | `0.3, 0, 1, 1` | `--duration-exit` | Utility exit |

Expressive springs (Motion library) only on consumer surfaces, and only where physics earns its bundle cost: currently the approved-receipt celebration alone. Entrance motion everywhere else is CSS (`.md3-enter`, `.md3-stagger-item`), which costs no client JavaScript and runs before hydration.

**Reduced motion is structural, not a switch.** Every keyframe and every `animation:` declaration lives INSIDE `@media (prefers-reduced-motion: no-preference)`. Defining animations globally and disabling them in a `reduce` block fails open - forget one and it animates for the people who asked it not to. Defining them only inside `no-preference` fails closed. `src/app/reduced-motion.test.ts` asserts this property over `globals.css`, so a top-level `animation:` fails the build.

**Never `AnimatePresence mode="wait"` on a state machine that can change state mid-exit.** It deadlocked consumer onboarding: the outgoing step never finished exiting, so the incoming one never mounted and the flow froze on step 1. Entrance-only animation keyed on the state (`key={step}`, `key={outcome}`) gives the same effect with nothing to wait for.

## Component registry (implemented)

| Component | File | Variants |
|---|---|---|
| Button | `src/components/ui/button.tsx` | filled, tonal, outlined, text, elevated; sizes sm/md/touch |
| Card | `src/components/ui/card.tsx` | filled, elevated, outlined |
| TextField | `src/components/ui/text-field.tsx` | default, helper, error, disabled (label above; error below with role=alert) |
| Chip | `src/components/ui/chip.tsx` | selected / unselected |
| Badge | `src/components/ui/badge.tsx` | reward badge (tertiary) |
| Skeleton | `src/components/ui/skeleton.tsx` | `Skeleton`, `SkeletonText`, `SkeletonCircle`, `SkeletonScreen` |
| Progress | `src/components/ui/progress.tsx` | `LinearProgress` (determinate/indeterminate), `CircularProgress` (sm/md/lg) |
| RefreshIndicator | `src/components/ui/refresh-indicator.tsx` | - |
| PendingButton | `src/components/ui/pending-button.tsx` | `PendingButton` (controlled), `SubmitButton` (`useFormStatus`), `FormPending` (render prop) |
| Stagger | `src/components/motion/stagger.tsx` | `Enter`, `StaggerItem` |
| BottomNav + Scan FAB | `src/components/shell/bottom-nav.tsx` | consumer shell |
| Logo | `src/components/brand/logo.tsx` | mark, wordmark, lockup, stamp |

New components follow MD3 anatomy, live in `src/components/ui`, and are added to this table plus the `/design` showcase in the same PR.

## Loading vocabulary (Locked)

Four situations, four answers. The distinction is MD3's: a **skeleton** stands in for content that has not arrived, a **progress indicator** reports that a process is running. Picking between them is not taste, and neither is determinate vs indeterminate.

| Situation | Use | Why not the others |
|---|---|---|
| **Route transition** - navigating to a page whose server work has not finished | **Skeleton** matching the real layout, in `loading.tsx` | Nothing is on screen yet, so the job is to RESERVE the layout. A centred spinner on an empty page feels slower than nothing, because it reports a wait without reducing it. |
| **In-place data refresh** - content already on screen, being replaced | **Indeterminate `LinearProgress`** pinned to the top of the region (`RefreshIndicator`), content stays visible | Replacing content the user is reading with grey bones is a downgrade. Four pixels says the same thing without taking anything away. |
| **Form submission / discrete action** - a button was pressed | **`PendingButton` / `SubmitButton`**: `CircularProgress` in the control, `disabled`, `aria-busy` | The feedback belongs to the CONTROL, not the page. A page-level bar for a button press disconnects cause from effect. |
| **Long operation with real stages** - receipt upload and processing | **Indeterminate `LinearProgress` plus staged copy** | Determinate ONLY when a genuine fraction exists. Upload reports no fraction; a fabricated percentage that sticks at 90% is why people distrust progress bars. |

Rules that follow from this:

1. **A skeleton must occupy the same space as its loaded counterpart.** A mismatched skeleton trades a blank screen for a visible jump, which is a worse trade. CLS is measured. `src/app/loading-skeletons.test.tsx` pins the counts that are fixed by the real components (four KPI cards, eight table columns, seven opening-hours rows).
2. **Skeletons are tokens only, and must be visible in BOTH themes.** `bg-surface-container-high` is a real tonal step above `surface` in light and dark. A hardcoded light grey is invisible on a dark surface and is the classic way a skeleton ships broken. Asserted per file.
3. **A generic loading state never uses tertiary/mango.** It is reward language; "something is loading" is not a reward. Asserted per file.
4. **Skeleton bones are `aria-hidden`; the screen announces itself once** via `SkeletonScreen`'s `aria-busy` + polite `Loading {label}.` A screen reader walking fifty empty divs is having a worse time than one that hears a sentence.
5. **A pending control must not change width.** `PendingButton` renders the idle and pending labels in one CSS grid cell, so the button is as wide as the longer label from first paint. The inactive label is `aria-hidden` so the accessible name stays a single label.
6. **Optimism only where the outcome is certain.** Marking a notification read is optimistic because `openNotification` marks-then-redirects unconditionally; there is no successful path where the row stays unread. Anything with a real failure branch waits for the server.

### Coverage

`loading.tsx` exists for every route that does real server work:

- **Consumer:** `/home`, `/wallet`, `/rewards`, `/receipts`, `/scan`, `/b/[slug]`, `/notifications`
- **Business portal:** `/dashboard`, `/menu`, `/campaigns`, `/customers`, `/rewards`, `/receipts`, `/receipts/[receiptId]`, `/settings`

Skeletons render INSIDE their layout, so the consumer bottom nav and the portal sidebar/topbar persist across the navigation. That persistence is most of why a route transition feels fast; do not redraw them in a skeleton.

## Maps

A basemap tile is a photograph and will not answer to a token. The rule, so no future map surface has to re-decide it:

1. **Ask the provider for dark pixels.** Two tile styles, light and dark (`src/lib/maps/tile-source.ts`). Never `filter: invert()` — it turns parks purple, water orange and label text into a grey ghost.
2. **Let the browser pick, do not render both.** `<picture>` with `media="(prefers-color-scheme: dark)"`. A `dark:` class toggle does not stop the hidden image being fetched, so it would double the tile quota to show one map. The consequence is accepted and named: the map follows the OS scheme while chrome follows next-themes, and those disagree only for a visitor who has explicitly overridden the theme in-app. The map therefore always sits in a token-styled frame (`outline-variant` border, `surface-container` background), so it reads as a framed picture rather than as a theme failure.
3. **Attribution renders, always.** ODbL 4.3 plus the tile host's terms. Solid `surface-container` chip, never a translucent overlay: the backdrop is arbitrary imagery.
4. **The pin is CSS, not an image** (`src/components/maps/map-chrome.tsx`), so it takes `primary`/`on-primary` in both themes. Its point is the bottom-centre of its box after the rotation; anchor accordingly.
5. **A map never hijacks the page scroll.** Gesture handlers are opt-in behind a deliberate tap; wheel zoom is off everywhere. Zoom controls are 48px, so Leaflet's own 26px control is switched off.
6. **Every map has a non-visual equal.** The address and the coordinates are text and the directions link is an anchor, so the task can be completed without touching the map at all.

## Surface profiles

- **Consumer PWA** (expressive): coral leads; bottom nav + center Scan FAB (compact), rail (medium+); bottom sheets for flows; springy reward moments; generous spacing; `size="touch"` buttons.
- **Business portal** (productive): teal leads; denser spacing; rail/drawer; Tremor/TanStack themed via one chart-theme file reading tokens; no expressive motion.
- **Admin portal** (utilitarian): neutral surfaces, maximum density, zero expressive motion.

## Adaptive rules

Window size classes: compact < 600px, medium 600-840px, expanded > 840px. Every screen spec declares behavior per class. Ergonomics: 48px targets with 8px gaps; primary actions in thumb zone on compact; destructive never adjacent to primary. PWA chrome: safe-area insets, `theme-color` = surface per scheme (see `src/app/layout.tsx` viewport + `src/app/manifest.ts`), maskable icons.

## Accessibility

WCAG AA (4.5:1 body, 3:1 large/UI) minimum; AAA (7:1) target on money/points figures. Skeletons (never raw spinners on portals), designed empty states, inline errors: mandatory on every data view.

## Do / Don't

- DO use `bg-primary text-on-primary` style pairs. DON'T invent pairings.
- DO put labels above inputs. DON'T use floating labels or placeholder-as-label.
- DO use tonal surfaces for depth. DON'T add shadows outside FAB/dialog/menu.
- DO gate animation behind reduced-motion by defining it inside `no-preference`. DON'T define animation globally and switch it off in a `reduce` block.
- DO match a skeleton to the shape of its loaded content. DON'T ship a centred spinner as a route loading state.
- DO give every tapped button a visible pending state that cannot be tapped twice. DON'T let a label change resize the control.
- DON'T use mango/tertiary outside rewards + Scan FAB.
- DON'T import a second component library or `@material/web`.
