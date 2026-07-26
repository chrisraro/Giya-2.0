import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TextField } from "@/components/ui/text-field";
import { Chip } from "@/components/ui/chip";
import { Badge } from "@/components/ui/badge";
import { Skeleton, SkeletonCircle, SkeletonText } from "@/components/ui/skeleton";
import { PendingButton } from "@/components/ui/pending-button";
import { CircularProgress, LinearProgress } from "@/components/ui/progress";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/design/theme-toggle";

import { isDesignRouteEnabled } from "./dev-only";

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

/**
 * The internal MD3 swatch board: every colour role, the full type ramp, and a
 * gallery of every component, on one screen in both themes. It is how colour
 * and type regressions get caught, and it is DEVELOPMENT ONLY.
 *
 * IT USED TO BE PUBLICLY LIVE. `src/middleware.ts`'s matcher excludes
 * `_next`, `favicon` and `brand/` and nothing else, so this internal tool was
 * served to anyone who guessed the URL on the production deployment.
 *
 * WHY IT IS NOT DELETED: it is a working development tool, and deleting one
 * to fix a routing problem is the wrong trade.
 *
 * WHY THE GUARD IS HERE AND NOT IN MIDDLEWARE: a middleware branch was the
 * first attempt and was measured and rejected. Middleware can only 404 by
 * returning a bare `NextResponse(null, { status: 404 })` - which hands the
 * visitor the browser's blank error page instead of the app's designed one -
 * or by rewriting to an unmatched path, which rendered the right page but
 * answered HTTP 200 for `/design` itself. A soft 404 is worse than the
 * original bug, because it is indexable. It would also have put route-specific
 * product logic on the hot path of every request in the app.
 *
 * WHY NOT A `layout.tsx` GUARD, WHICH WOULD ALSO COVER FUTURE CHILDREN: also
 * tried, also measured, also rejected. See the note in `./dev-only` - a layout
 * receives `children` already resolved, so the page's component tree still
 * lands in the response's RSC payload and the swatches leak inside a 404.
 *
 * `notFound()` here is the framework's own mechanism: a real 404 status with
 * the root `not-found.tsx` body, decided at prerender time by `next build`
 * rather than per request, and with nothing of this page in the output.
 */
export default function DesignPage() {
  if (!isDesignRouteEnabled(process.env.NODE_ENV)) {
    notFound();
  }

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

      {/* The loading vocabulary, side by side, so the four situations can be
          compared rather than described. Doc 16 "Loading vocabulary" is the
          rule this section illustrates. */}
      <section className="space-y-4">
        <h2 className="text-headline-s">Loading vocabulary</h2>

        <div className="space-y-2">
          <h3 className="text-title-s text-on-surface-variant">
            Route transition: skeleton matching the real layout
          </h3>
          <Card variant="outlined" className="max-w-sm space-y-2 p-4">
            <SkeletonText size="title-m" className="w-40" />
            <SkeletonText size="body-s" className="w-24" />
            <div className="flex items-center gap-3 pt-2">
              <SkeletonCircle className="size-10" />
              <div className="min-w-0 flex-1">
                <SkeletonText size="body-l" className="w-32" />
                <SkeletonText size="body-s" className="w-20" />
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-2">
          <h3 className="text-title-s text-on-surface-variant">
            In-place refresh and long operations: linear progress
          </h3>
          <div className="max-w-sm space-y-3">
            <LinearProgress label="Refreshing, indeterminate" />
            <LinearProgress label="Uploading, 60 percent" value={0.6} />
          </div>
        </div>

        <div className="space-y-2">
          <h3 className="text-title-s text-on-surface-variant">
            Form submission: pending control, fixed width
          </h3>
          <div className="flex flex-wrap items-center gap-3">
            <PendingButton pending={false} pendingLabel="Claiming" variant="tonal">
              Claim
            </PendingButton>
            <PendingButton pending pendingLabel="Claiming" variant="tonal">
              Claim
            </PendingButton>
            <CircularProgress size="md" label="Working" />
          </div>
          <p className="text-body-s text-on-surface-variant">
            Both buttons are the same width: the idle and pending labels share
            one grid cell, so pressing it moves nothing.
          </p>
        </div>
      </section>
    </main>
  );
}
