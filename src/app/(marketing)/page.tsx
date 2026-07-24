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
                  <span className="absolute -left-[55px] flex size-11 items-center justify-center rounded-full bg-primary text-on-primary md:-left-[63px]">
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
    </main>
  );
}
