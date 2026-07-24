# Giya Marketing Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-07-24-marketing-site-design.md`: a `(marketing)` route group with landing page (`/`), `/business`, `/privacy`, `/terms`, consuming the existing Giya design system.

**Architecture:** Server components by default; client islands only for the mobile nav menu and Motion reveals. FAQ uses native `<details>/<summary>` (no JS). Marketing pages force light theme via a `.light` wrapper (generator emits light tokens under `:root, .light`). All visuals are real component previews.

**Tech Stack:** Existing stack + `motion` (the Motion library, imported from `motion/react`).

## Global Constraints

- Tokens only in `src/` (lint-enforced); Geist via existing setup; Material Symbols icons only (already loaded); no new icon or component libraries.
- Shape rules: buttons/chips full; cards `rounded-md3-md`; large marketing panels may use `rounded-md3-xl` (28px).
- Mango/tertiary tokens ONLY on reward moments (points badges, stamp logo) - never on layout or business content. Teal (secondary) leads business content.
- One light theme across all marketing pages (`.light` wrapper); no `dark:` variants in marketing components.
- Copy rules (design-taste): ZERO em-dash characters anywhere; headlines <=8 words; section sub-paragraphs <=25 words; hero subtext <=20 words and CTAs visible without scroll; max 3 eyebrows across the landing page; every CTA intent has ONE label: "Open Giya" (app), "For businesses" (business page), "Join the pilot" (mailto).
- All Motion animation honors `useReducedMotion`; CSS animations use `motion-reduce:` guards.
- 48px touch targets for all marketing CTAs (`size="touch"` Buttons or equivalent).
- Conventional Commits, scope `marketing` (e.g. `feat(marketing): ...`); commit at end of every task.
- Mailto CTA: `mailto:teamocsph@gmail.com?subject=Giya%20pilot%20application`.
- Working dir: repo root, branch `feat/marketing-site`.

---

### Task 1: Theme-lock plumbing, Motion install, marketing shell (nav + footer + routes)

**Files:**
- Modify: `scripts/generate-md3-tokens.ts` (one line: `:root {` -> `:root, .light {`)
- Regenerate: `src/styles/md3-tokens.css`
- Modify: `scripts/generate-md3-tokens.test.ts` (expectation update)
- Modify: `src/lib/md3-token-hex.ts` (regex update for the new selector)
- Create: `src/components/marketing/nav.tsx`, `src/components/marketing/footer.tsx`, `src/components/marketing/reveal.tsx`
- Create: `src/app/(marketing)/layout.tsx`, `src/app/(marketing)/page.tsx` (placeholder this task)
- Delete: `src/app/page.tsx` (the redirect)
- Test: `src/components/marketing/nav.test.tsx`

**Interfaces:**
- Produces: `<MarketingNav />`, `<MarketingFooter />`, `<Reveal delay? className?>` (client, motion fade-up `whileInView`, reduced-motion safe). Later tasks import these exact names from `@/components/marketing/nav`, `.../footer`, `.../reveal`.
- Produces: `(marketing)/layout.tsx` wraps children in `<div className="light min-h-dvh bg-surface text-on-surface">` with nav above and footer below.

- [ ] **Step 1: Install Motion**

```bash
npm i motion
```

- [ ] **Step 2: Generator selector change + test**

In `scripts/generate-md3-tokens.ts` change the template line `:root {` to `:root, .light {`. In `scripts/generate-md3-tokens.test.ts` change the assertion `expect(c).toContain(":root {")` to `expect(c).toContain(":root, .light {")`. In `src/lib/md3-token-hex.ts` change the light-scheme match from `/:root \{[^}]*\}/` to `/:root, \.light \{[^}]*\}/`. Run `npm run gen:tokens`, then `npx vitest run scripts/generate-md3-tokens.test.ts` -> PASS.

- [ ] **Step 3: Write failing nav test**

`src/components/marketing/nav.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MarketingNav } from "./nav";

describe("MarketingNav", () => {
  it("renders brand lockup link and the app CTA", () => {
    render(<MarketingNav />);
    expect(screen.getByRole("link", { name: /giya home/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Open Giya" })).toHaveAttribute("href", "/home");
  });
  it("renders section links", () => {
    render(<MarketingNav />);
    expect(screen.getByRole("link", { name: "How it works" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "For businesses" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "FAQ" })).toBeInTheDocument();
  });
});
```
Run: `npx vitest run src/components/marketing/nav.test.tsx` -> FAIL (module not found).

- [ ] **Step 4: Create the three shared components**

`src/components/marketing/nav.tsx`:
```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/business", label: "For businesses" },
  { href: "/#faq", label: "FAQ" },
] as const;

export function MarketingNav() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-outline-variant/60 bg-surface/90 backdrop-blur">
      <nav aria-label="Main" className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link href="/" aria-label="Giya home" className="text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <Logo variant="lockup" />
        </Link>
        <div className="hidden items-center gap-6 md:flex">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="text-label-l text-on-surface-variant transition-colors hover:text-on-surface">
              {l.label}
            </Link>
          ))}
          <Link href="/home" className={buttonVariants({ variant: "filled", size: "md" })}>
            Open Giya
          </Link>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen(!open)}
          className="flex size-12 items-center justify-center rounded-full text-on-surface md:hidden"
        >
          <span aria-hidden className="material-symbols-rounded">{open ? "close" : "menu"}</span>
        </button>
      </nav>
      {open && (
        <div className="border-t border-outline-variant bg-surface px-4 py-4 md:hidden">
          <div className="flex flex-col gap-1">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="rounded-md3-sm px-3 py-3 text-body-l text-on-surface hover:bg-surface-container">
                {l.label}
              </Link>
            ))}
            <Link href="/home" onClick={() => setOpen(false)} className={cn(buttonVariants({ variant: "filled", size: "touch" }), "mt-2")}>
              Open Giya
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
```

`src/components/marketing/footer.tsx` (server):
```tsx
import Link from "next/link";
import { Logo } from "@/components/brand/logo";

const COLUMNS = [
  { title: "Product", links: [{ href: "/home", label: "Open Giya" }, { href: "/business", label: "For businesses" }] },
  { title: "Legal", links: [{ href: "/privacy", label: "Privacy policy" }, { href: "/terms", label: "Terms of service" }] },
] as const;

export function MarketingFooter() {
  return (
    <footer className="border-t border-outline-variant bg-surface-container-low">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:grid-cols-2 md:grid-cols-4">
        <div className="space-y-3">
          <div className="text-primary"><Logo variant="lockup" /></div>
          <p className="text-body-s text-on-surface-variant">Turn every receipt into rewards.</p>
        </div>
        {COLUMNS.map((col) => (
          <div key={col.title}>
            <h3 className="text-title-s text-on-surface">{col.title}</h3>
            <ul className="mt-3 space-y-2">
              {col.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-body-m text-on-surface-variant transition-colors hover:text-on-surface">{l.label}</Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div>
          <h3 className="text-title-s text-on-surface">Contact</h3>
          <a href="mailto:teamocsph@gmail.com" className="mt-3 block text-body-m text-on-surface-variant transition-colors hover:text-on-surface">teamocsph@gmail.com</a>
        </div>
      </div>
      <div className="border-t border-outline-variant/60">
        <p className="mx-auto max-w-6xl px-4 py-4 text-body-s text-on-surface-variant">© 2026 Giya. Made in the Philippines.</p>
      </div>
    </footer>
  );
}
```

`src/components/marketing/reveal.tsx`:
```tsx
"use client";

import { motion, useReducedMotion } from "motion/react";

export function Reveal({ children, delay = 0, className }: { children: React.ReactNode; delay?: number; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
```

- [ ] **Step 5: Marketing layout + placeholder page; remove root redirect**

`src/app/(marketing)/layout.tsx`:
```tsx
import { MarketingNav } from "@/components/marketing/nav";
import { MarketingFooter } from "@/components/marketing/footer";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="light flex min-h-dvh flex-col bg-surface text-on-surface">
      <MarketingNav />
      <div className="flex-1">{children}</div>
      <MarketingFooter />
    </div>
  );
}
```
`src/app/(marketing)/page.tsx` (placeholder, replaced in Task 2):
```tsx
export default function LandingPage() {
  return <main className="mx-auto max-w-6xl px-4 py-24"><h1 className="text-display-s">Giya</h1></main>;
}
```
Delete `src/app/page.tsx`.

- [ ] **Step 6: Verify + commit**

`npx vitest run src/components/marketing/nav.test.tsx` -> PASS. `npm test` all green. `npm run build` clean (note: `/` now renders the marketing layout). Commit: `feat(marketing): marketing shell with nav, footer, light-lock, motion`

---

### Task 2: Landing hero + phone preview + how-it-works

**Files:**
- Create: `src/components/marketing/phone-preview.tsx`
- Modify: `src/app/(marketing)/page.tsx` (replace placeholder with hero + how-it-works; later sections arrive in Task 3)
- Test: `src/components/marketing/phone-preview.test.tsx`

**Interfaces:**
- Consumes: `Reveal`, `Card/CardHeader/CardTitle/CardContent`, `Badge`, `Logo`, `buttonVariants`, `cn`.
- Produces: `<PhonePreview />` (server component).

- [ ] **Step 1: Failing test**

`src/components/marketing/phone-preview.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PhonePreview } from "./phone-preview";

describe("PhonePreview", () => {
  it("shows a points balance and reward badge from real components", () => {
    render(<PhonePreview />);
    expect(screen.getByText("1,250 pts")).toBeInTheDocument();
    expect(screen.getByText("+120 pts")).toBeInTheDocument();
    expect(screen.getByText("Kape Diaria")).toBeInTheDocument();
  });
});
```
Run -> FAIL (module not found).

- [ ] **Step 2: `src/components/marketing/phone-preview.tsx`**

A phone frame composing REAL design-system components (decorative; `aria-hidden` on icon glyphs). Structure (implementer writes exact classes to match this layout; keep every color a token utility):
```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { icon: "home", label: "Home", active: true },
  { icon: "account_balance_wallet", label: "Wallet", active: false },
  { icon: "redeem", label: "Rewards", active: false },
  { icon: "person", label: "Profile", active: false },
] as const;

export function PhonePreview({ className }: { className?: string }) {
  return (
    <div className={cn("relative mx-auto w-[290px] select-none rounded-[2.25rem] border-8 border-inverse-surface bg-surface shadow-xl", className)}>
      <div className="space-y-4 px-4 pb-20 pt-8">
        <div className="flex items-center justify-between">
          <p className="text-title-m">Magandang umaga, Mia</p>
          <div className="text-primary"><Logo variant="mark" className="size-6" /></div>
        </div>
        <Card variant="elevated">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Kape Diaria</CardTitle>
              <Badge>+120 pts</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-headline-s text-on-surface">1,250 pts</p>
            <p className="mt-1">3 stamps to your free latte</p>
          </CardContent>
        </Card>
        <div className="flex items-center justify-between rounded-md3-md bg-surface-container px-4 py-3">
          <div className="flex gap-2 text-tertiary">
            {[0, 1, 2].map((i) => (<Logo key={i} variant="stamp" className="size-7" />))}
            {[0, 1].map((i) => (<Logo key={`e${i}`} variant="stamp" className="size-7 opacity-25" />))}
          </div>
          <p className="text-label-m text-on-surface-variant">3 of 5</p>
        </div>
      </div>
      {/* Mini bottom-nav strip mirroring the real app shell */}
      <div className="absolute inset-x-0 bottom-0 rounded-b-[1.75rem] border-t border-outline-variant bg-surface-container px-3 pb-3 pt-1">
        <div className="flex items-center justify-between">
          {NAV_ITEMS.slice(0, 2).map((n) => (<MiniNavItem key={n.icon} {...n} />))}
          <span className="flex size-11 -translate-y-3 items-center justify-center rounded-md3-lg bg-tertiary-container text-on-tertiary-container shadow-lg">
            <span aria-hidden className="material-symbols-rounded text-[20px]">document_scanner</span>
          </span>
          {NAV_ITEMS.slice(2).map((n) => (<MiniNavItem key={n.icon} {...n} />))}
        </div>
      </div>
    </div>
  );
}

function MiniNavItem({ icon, label, active }: (typeof NAV_ITEMS)[number]) {
  return (
    <span className="flex flex-col items-center gap-0.5">
      <span className={cn("flex h-6 w-10 items-center justify-center rounded-full", active && "bg-primary-container")}>
        <span aria-hidden className={cn("material-symbols-rounded text-[18px]", active ? "is-filled text-on-primary-container" : "text-on-surface-variant")}>{icon}</span>
      </span>
      <span className={cn("text-[10px] font-medium", active ? "text-on-surface" : "text-on-surface-variant")}>{label}</span>
    </span>
  );
}
```
Run test -> PASS.

- [ ] **Step 3: Hero + how-it-works into `(marketing)/page.tsx`**

Replace the placeholder. Exact copy (verbatim); layout notes in comments are binding:
```tsx
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { PhonePreview } from "@/components/marketing/phone-preview";
import { Reveal } from "@/components/marketing/reveal";
import { cn } from "@/lib/utils";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Giya | Turn every receipt into rewards",
  description:
    "Scan the receipts you already get, earn points at your favorite Philippine food and retail spots, and redeem real rewards. Free for consumers.",
};

const STEPS = [
  { icon: "document_scanner", title: "Scan", body: "Snap the paper receipt you already got. No new checkout steps, nothing for the cashier to learn." },
  { icon: "stars", title: "Earn", body: "Points land in your wallet automatically once the receipt checks out. Watch your stamps fill up." },
  { icon: "redeem", title: "Redeem", body: "Claim a reward, show the QR at the counter, and walk away with your free item." },
] as const;

export default function LandingPage() {
  return (
    <main>
      {/* HERO: asymmetric split, copy left / phone right; stacks on mobile with phone below */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-20 pt-14 md:grid-cols-[1.1fr_0.9fr] md:pt-20">
        <Reveal>
          <div className="max-w-xl">
            <h1 className="text-display-s md:text-display-m">Your receipts are worth something.</h1>
            <p className="mt-5 max-w-md text-body-l text-on-surface-variant">
              Scan the receipt you already got, earn points at your favorite spots, and turn them into real rewards.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/home" className={buttonVariants({ variant: "filled", size: "touch" })}>Open Giya</Link>
              <Link href="/business" className={buttonVariants({ variant: "outlined", size: "touch" })}>For businesses</Link>
            </div>
          </div>
        </Reveal>
        <Reveal delay={0.15} className="justify-self-center md:justify-self-end">
          <PhonePreview />
        </Reveal>
      </section>

      {/* HOW IT WORKS: vertical numbered flow with connecting line, NOT three equal cards */}
      <section id="how-it-works" className="bg-surface-container-low py-20">
        <div className="mx-auto max-w-6xl px-4">
          <Reveal><h2 className="text-headline-l">How it works</h2></Reveal>
          <ol className="relative mt-10 max-w-2xl space-y-12 border-l-2 border-outline-variant pl-8 md:pl-10">
            {STEPS.map((s, i) => (
              <Reveal key={s.title} delay={i * 0.08}>
                <li className="relative">
                  <span className="absolute -left-[3.35rem] flex size-11 items-center justify-center rounded-full bg-primary text-on-primary md:-left-[3.85rem]">
                    <span aria-hidden className="material-symbols-rounded">{s.icon}</span>
                  </span>
                  <h3 className="text-title-l">{s.title}</h3>
                  <p className="mt-2 max-w-md text-body-l text-on-surface-variant">{s.body}</p>
                </li>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>
    </main>
  );
}
```
(Implementer: fine-tune the absolute offsets so the numbered dots sit centered on the border line at both breakpoints; verify visually.)

- [ ] **Step 4: Verify + commit**

`npm test` green; `npm run build` clean; dev-server curl `/` contains "Your receipts are worth something." Commit: `feat(marketing): landing hero, phone preview, how-it-works`

---

### Task 3: Landing lower sections (consumers, business band, trust, FAQ, CTA)

**Files:**
- Modify: `src/app/(marketing)/page.tsx` (append sections inside `<main>` after how-it-works)

**Interfaces:** consumes existing components only.

- [ ] **Step 1: Append the five sections**

Exact copy verbatim; append after the how-it-works `</section>`:
```tsx
      {/* FOR CONSUMERS: benefits, 2-col asymmetric; mango only on the reward figures */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <Reveal>
          <h2 className="max-w-xl text-headline-l">One wallet for every suki card you own</h2>
        </Reveal>
        <div className="mt-10 grid gap-6 md:grid-cols-[1.2fr_1fr]">
          <Reveal>
            <div className="flex h-full flex-col justify-between rounded-md3-xl bg-surface-container p-8">
              <p className="max-w-md text-body-l text-on-surface-variant">
                Paper punch cards get lost. Giya keeps every program, every stamp, and every point in one place, synced the moment your receipt is approved.
              </p>
              <div className="mt-8 flex items-center gap-4">
                <span className="rounded-full bg-tertiary-container px-4 py-2 font-mono text-title-m text-on-tertiary-container">1,250 pts</span>
                <p className="text-body-m text-on-surface-variant">never expire without warning</p>
              </div>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="flex h-full flex-col gap-6 rounded-md3-xl bg-primary-container p-8 text-on-primary-container">
              <span aria-hidden className="material-symbols-rounded text-4xl">notifications_active</span>
              <p className="text-title-l">Know the moment points land</p>
              <p className="text-body-m">Scan at the counter, get the push before your coffee is ready. Pending points settle automatically.</p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* FOR BUSINESSES: teal band */}
      <section className="bg-secondary-container py-20 text-on-secondary-container">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 md:grid-cols-[1.2fr_0.8fr]">
          <Reveal>
            <div>
              <h2 className="max-w-xl text-headline-l">Run loyalty like the big chains, without their budget</h2>
              <p className="mt-4 max-w-lg text-body-l">
                Campaigns, points, rewards, and customer insight from the receipts you already print. No POS integration, no new hardware, no IT staff needed.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1} className="md:justify-self-end">
            <Link href="/business" className={buttonVariants({ variant: "filled", size: "touch" })}>For businesses</Link>
          </Reveal>
        </div>
      </section>

      {/* TRUST STRIP: quiet, factual, three columns */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <div className="grid gap-10 md:grid-cols-3">
          {[
            { icon: "verified_user", title: "Every scan is checked", body: "Duplicate and fraud detection reviews each receipt before points are awarded." },
            { icon: "lock", title: "Your data stays yours", body: "Built for the PH Data Privacy Act. Marketing is opt-in and separate from your account." },
            { icon: "receipt_long", title: "Points you can trust", body: "Every point lives in a tamper-proof ledger. Balances always add up." },
          ].map((t, i) => (
            <Reveal key={t.title} delay={i * 0.08}>
              <div>
                <span aria-hidden className="material-symbols-rounded text-3xl text-secondary">{t.icon}</span>
                <h3 className="mt-3 text-title-m">{t.title}</h3>
                <p className="mt-2 text-body-m text-on-surface-variant">{t.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* FAQ: native details/summary accordion */}
      <section id="faq" className="bg-surface-container-low py-20">
        <div className="mx-auto max-w-3xl px-4">
          <Reveal><h2 className="text-headline-l">Questions, answered</h2></Reveal>
          <div className="mt-8 divide-y divide-outline-variant">
            {[
              { q: "What is Giya?", a: "Giya is a free app that turns paper receipts from participating food and retail stores into loyalty points and rewards. Scan the receipt, earn the points, redeem at the counter." },
              { q: "Does it cost anything?", a: "No. Giya is free for consumers. Businesses choose a plan once paid tiers launch; the pilot is free for them too." },
              { q: "How do I earn points?", a: "Buy like you normally do, then scan the receipt in the app. Once it passes our checks, points and stamps land in your wallet automatically." },
              { q: "Which businesses can join?", a: "Food and retail businesses in the Philippines with printed receipts. If that is you, apply for the pilot from the For businesses page." },
              { q: "Is my data safe?", a: "Yes. We follow the PH Data Privacy Act, keep marketing strictly opt-in, and never sell your personal data. See the privacy policy for details." },
            ].map((f) => (
              <details key={f.q} className="group py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-title-m text-on-surface [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <span aria-hidden className="material-symbols-rounded transition-transform group-open:rotate-180">expand_more</span>
                </summary>
                <p className="mt-3 max-w-xl text-body-l text-on-surface-variant">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* FINAL CTA BAND: coral */}
      <section className="bg-primary py-20 text-on-primary">
        <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 md:flex-row md:items-center md:justify-between">
          <Reveal>
            <h2 className="max-w-xl text-headline-l">Your next receipt could be worth a free one.</h2>
          </Reveal>
          <Reveal delay={0.1}>
            <Link href="/home" className={cn(buttonVariants({ variant: "elevated", size: "touch" }))}>Open Giya</Link>
          </Reveal>
        </div>
      </section>
```

- [ ] **Step 2: Verify + commit**

`npm test` green; `npm run build` clean; curl `/` contains "Questions, answered" and "suki". Commit: `feat(marketing): landing sections (consumers, business band, trust, faq, cta)`

---

### Task 4: `/business` page

**Files:**
- Create: `src/app/(marketing)/business/page.tsx`

- [ ] **Step 1: Create the page** (exact copy verbatim)

```tsx
import Link from "next/link";
import type { Metadata } from "next";
import { buttonVariants } from "@/components/ui/button";
import { Reveal } from "@/components/marketing/reveal";

export const metadata: Metadata = {
  title: "Giya for Businesses | Loyalty without the hardware",
  description:
    "Campaigns, points, rewards, and customer intelligence from the receipts you already print. Join the Giya pilot for Philippine food and retail SMEs.",
};

const MAILTO = "mailto:teamocsph@gmail.com?subject=Giya%20pilot%20application";

const PROPS = [
  { icon: "campaign", title: "Campaign engine", body: "Promotions, rewards, and loyalty programs from templates. Schedule them like a social post." },
  { icon: "loyalty", title: "Points and rewards", body: "Set how customers earn, cap what you give away, and validate redemptions with a scan." },
  { icon: "insights", title: "Customer intelligence", body: "See visits, spend, and your regulars by name. Know whether promos actually work." },
  { icon: "power_off", title: "Zero hardware", body: "Your printed receipt is the integration. No POS changes, no tablets, no staff training." },
] as const;

const PILOT_STEPS = [
  { title: "Apply", body: "Email us about your business. We onboard a small pilot cohort personally." },
  { title: "Verify", body: "Submit your permit and business details in the portal. We verify within days." },
  { title: "Launch", body: "Pick a template campaign and go live. Your customers start scanning the same week." },
] as const;

export default function BusinessPage() {
  return (
    <main>
      <section className="mx-auto max-w-6xl px-4 pb-16 pt-14 md:pt-20">
        <Reveal>
          <div className="max-w-2xl">
            <h1 className="text-display-s">Know your customers. Keep them coming back.</h1>
            <p className="mt-5 max-w-lg text-body-l text-on-surface-variant">
              Giya gives Philippine food and retail SMEs an enterprise-grade loyalty and marketing suite, powered by the receipts you already print.
            </p>
            <a href={MAILTO} className={buttonVariants({ variant: "filled", size: "touch" }) + " mt-8"}>Join the pilot</a>
          </div>
        </Reveal>
      </section>

      <section className="bg-secondary-container py-20 text-on-secondary-container">
        <div className="mx-auto max-w-6xl px-4">
          <Reveal><h2 className="text-headline-l">Everything a repeat-customer machine needs</h2></Reveal>
          <div className="mt-10 grid gap-x-10 gap-y-12 sm:grid-cols-2">
            {PROPS.map((p, i) => (
              <Reveal key={p.title} delay={i * 0.06}>
                <div>
                  <span aria-hidden className="material-symbols-rounded text-3xl">{p.icon}</span>
                  <h3 className="mt-3 text-title-l">{p.title}</h3>
                  <p className="mt-2 max-w-md text-body-l">{p.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20">
        <Reveal><h2 className="text-headline-l">How the pilot works</h2></Reveal>
        <ol className="mt-10 grid gap-8 md:grid-cols-3">
          {PILOT_STEPS.map((s, i) => (
            <Reveal key={s.title} delay={i * 0.08}>
              <li className="rounded-md3-xl border border-outline-variant p-6">
                <p className="font-mono text-label-l text-secondary">{String(i + 1).padStart(2, "0")}</p>
                <h3 className="mt-2 text-title-l">{s.title}</h3>
                <p className="mt-2 text-body-m text-on-surface-variant">{s.body}</p>
              </li>
            </Reveal>
          ))}
        </ol>
        <Reveal delay={0.2}>
          <div className="mt-12 flex flex-col items-start gap-4 rounded-md3-xl bg-surface-container p-8 md:flex-row md:items-center md:justify-between">
            <p className="max-w-lg text-title-m">The pilot cohort is small on purpose. If you run a food or retail business in the Philippines, we want to hear from you.</p>
            <a href={MAILTO} className={buttonVariants({ variant: "filled", size: "touch" })}>Join the pilot</a>
          </div>
        </Reveal>
      </section>
    </main>
  );
}
```
Note: the pilot-step numerals ("01") are content numbering inside cards, permitted; they are not section-eyebrow numbering.

- [ ] **Step 2: Verify + commit**

`npm test` green; build clean; curl `/business` contains "Join the pilot" and the mailto href. Commit: `feat(marketing): business pitch page with pilot CTA`

---

### Task 5: `/privacy` and `/terms`

**Files:**
- Create: `src/components/marketing/legal-page.tsx` (shared prose wrapper)
- Create: `src/app/(marketing)/privacy/page.tsx`, `src/app/(marketing)/terms/page.tsx`

- [ ] **Step 1: Shared prose wrapper** `src/components/marketing/legal-page.tsx`:

```tsx
export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-[70ch] px-4 py-16">
      <h1 className="text-display-s">{title}</h1>
      <div className="mt-4 rounded-md3-md bg-tertiary-container/40 p-4">
        <p className="text-body-m text-on-surface">
          <strong>Draft for review.</strong> This document has not yet been reviewed by counsel. Effective date: to be set at launch.
        </p>
      </div>
      <div className="prose-giya mt-10 space-y-8">{children}</div>
    </main>
  );
}

export function LegalSection({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-headline-s">{heading}</h2>
      <div className="space-y-3 text-body-l leading-relaxed text-on-surface-variant">{children}</div>
    </section>
  );
}
```

- [ ] **Step 2: Privacy page** - full draft content, RA 10173-aware. `src/app/(marketing)/privacy/page.tsx` with `metadata.title = "Privacy Policy | Giya"` and `<LegalPage title="Privacy Policy">` containing these `LegalSection`s (write the full prose; summaries here are binding content requirements, expand each to 2-4 complete sentences of plain-language policy):
  1. **Who we are** - Giya operates a loyalty and rewards platform for Philippine food and retail businesses; contact teamocsph@gmail.com.
  2. **What we collect** - account details (name, email, optional phone and birth date), receipt images and the purchase data extracted from them, device and app-usage information, and business documents for merchant verification.
  3. **Why we collect it** - to award points accurately, prevent fraud (receipt checks, velocity limits), operate loyalty programs, and, only with separate opt-in consent, send marketing.
  4. **Consent and marketing** - marketing communications are opt-in and separate from the terms of service; consent can be withdrawn anytime in the app.
  5. **Who can see your data** - the businesses you scan at see your activity with them (name, visits, points), never your contact details unless you opt in; we do not sell personal data.
  6. **Your rights (RA 10173)** - access, correction, deletion, and data portability requests via teamocsph@gmail.com; deletion anonymizes ledger records rather than destroying financial-integrity records; complaints may be raised with the National Privacy Commission.
  7. **Retention and security** - data kept only while the account is active plus legally required periods; encryption in transit and at rest; sensitive identifiers (like TIN) stored encrypted.
  8. **Location data** - GPS attached to a scan only when the user opts in for fraud checks.
  9. **Changes to this policy** - material changes announced in-app; continued use after the effective date is acceptance.

- [ ] **Step 3: Terms page** - `src/app/(marketing)/terms/page.tsx` with `metadata.title = "Terms of Service | Giya"` and these sections (same expansion rule):
  1. **The service** - Giya connects consumers and participating businesses through receipt-based loyalty; we may change or discontinue features.
  2. **Accounts** - accurate information, one account per person, keep credentials safe, minimum age 18 or parental consent.
  3. **Earning points** - points are awarded for genuine purchases evidenced by valid receipts; we may reject receipts that fail our checks.
  4. **Points are not money** - points have no cash value, are not transferable or exchangeable for cash, and can expire per program rules shown in the app.
  5. **Acceptable use** - no fake, altered, borrowed, or duplicate receipts; no automation or abuse; violations can lead to point clawback, suspension, or termination.
  6. **Business participation** - businesses are responsible for honoring rewards they publish and for the accuracy of their listings.
  7. **Liability** - the service is provided as is; to the extent permitted by law our liability is limited to the value of unredeemed rewards affected by our error.
  8. **Governing law** - the laws of the Republic of the Philippines; venue in the proper courts of the operator's principal place of business.
  9. **Changes** - we may update these terms; material changes announced in-app with a fresh effective date.

- [ ] **Step 4: Verify + commit**

`npm test` green; build clean; curl `/privacy` contains "Draft for review", curl `/terms` contains "Points are not money". Commit: `feat(marketing): draft privacy policy and terms pages`

---

### Task 6 (controller): visual verification + design-taste pre-flight + finish

- [ ] Dev server: screenshot `/` (mobile 390 + desktop 1280), `/business`, `/privacy` - check hero fits viewport (headline <=2 lines, CTAs visible), section variety, nav one line, mango scoping, contrast.
- [ ] Mechanical pre-flight: grep built pages for em-dash characters; count `uppercase tracking` eyebrows (must be <=3); confirm single "Open Giya"/"For businesses"/"Join the pilot" label usage.
- [ ] Gates: lint, test, build.
- [ ] Final whole-branch review, fixes, merge per finishing-a-development-branch.
