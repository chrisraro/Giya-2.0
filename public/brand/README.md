# Giya brand assets

"Giya" is Filipino for "guide." The mark is a geometric **G** ring whose
negative-space counter (the open gap where a G's inner curve would close)
is cut to read as a compass needle pointing north-east — the app guides you
to your next reward.

## Construction

- Drawn on a 64×64 circle grid. The ring is a single arc path,
  `M52.5 20.5A24 24 0 1 0 56 32v-1.5H38`, a 24-radius circle opened at the
  east side with a crossbar stub running back to center — this is what
  reads as the G's counter/terminal.
- The needle is a simple kite quadrilateral,
  `M45 15 L31.5 22.5 L28 34 L41.5 26.5 Z`, drawn on the same NE-SW diagonal
  axis as the ring's opening (45 degrees off the horizontal/vertical grid),
  so the needle appears to point through the gap in the ring.
- Stroke weight for the ring is 9 (out of a 64 viewBox), round-capped, to
  keep the mark legible at small sizes (down to ~16px).

## Sanctioned lockups

Four forms, all built from the same two paths — never redraw or restyle
the mark itself:

1. **mark** (`mark.svg`) — the G-ring + needle alone. Default app icon /
   avatar use.
2. **wordmark** (`wordmark.svg`) — the word "giya" set lowercase, no mark.
   Use only where the mark already appears elsewhere on screen (e.g. next
   to a favicon in a browser tab).
3. **lockup** (`lockup.svg`) — mark + wordmark side by side, the primary
   horizontal signature. Use this for headers and the home screen brand
   row.
4. **stamp** (`stamp.svg`) — mark centered inside a dashed circle, a
   badge/seal treatment for things like verified-receipt or promotional
   stickers.

## Color rules

- `mark.svg`, `wordmark.svg`, `lockup.svg`, and `stamp.svg` all render in
  `currentColor` — they inherit color from whatever text-color class wraps
  them (e.g. `text-primary`) so they always track the live MD3 theme
  tokens. Never hardcode a hex value in these four files.
- `icon.svg` and `icon-maskable.svg` are the two exceptions: platform
  manifest icons are static files with no surrounding app chrome to inherit
  color from, so they embed literal hex values copied from the generated
  `src/styles/md3-tokens.css` **light-scheme** (`:root`) block:
  - background: `--md-sys-color-primary-container` = `#ffdad4`
  - mark: `--md-sys-color-on-primary-container` = `#400200`
  - If the brand seed colors are ever regenerated, re-copy these two
    values from `md3-tokens.css` into both icon files by hand — they do
    not update automatically.
- Never introduce any color into these files beyond the values above.
  `public/` brand assets are the one place raw hex is allowed in this
  repo (everything under `src/` must go through design tokens).

## Wordmark note

`wordmark.svg` and `lockup.svg` render "giya" as live `<text>` in the
Geist Sans font stack, not outlined paths. This is intentional for now —
converting the wordmark to true vector outlines (so it renders
identically regardless of whether Geist is loaded) is a brand-board task,
not an engineering one. Do that conversion once the brand board / logo
guidelines are finalized, then swap the `<text>` element for the
outlined `<path>` in both files.

## In-app rendering

For anything inside the Next.js app (not a static file reference), use
`src/components/brand/logo.tsx`'s `<Logo variant="mark|wordmark|lockup|stamp" />`
component instead of `<img src="/brand/*.svg">`. It inlines the same two
paths as real SVG elements colored with `currentColor`, so wrapping it in
a text-color utility class (e.g. `text-primary`) recolors it live with the
rest of the design system.
