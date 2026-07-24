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
