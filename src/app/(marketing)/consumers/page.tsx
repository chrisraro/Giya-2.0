import Link from "next/link";
import type { Metadata } from "next";
import { buttonVariants } from "@/components/ui/button";
import { PhonePreview } from "@/components/marketing/phone-preview";
import { Reveal } from "@/components/marketing/reveal";

const TITLE = "Giya for Consumers | Every suki card, one app";
const DESCRIPTION =
  "Giya is a free app that turns receipts from your favorite Philippine spots into points, stamps, and real rewards.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website" },
};

const BENEFITS = [
  {
    icon: "account_balance_wallet",
    title: "One wallet",
    body: "Every suki card you carry lives in a single app. No more digging through a stack of punch cards at checkout.",
    tone: "surface",
  },
  {
    icon: "verified",
    title: "Points that do not get lost",
    body: "A misplaced card used to mean lost points. Now everything stays in your account the moment a receipt is approved.",
    tone: "container",
  },
  {
    icon: "redeem",
    title: "Rewards worth claiming",
    body: "Free lattes, rice bowls, and milk tea, not vague discounts. See how many points stand between you and the next one.",
    tone: "reward",
  },
  {
    icon: "bolt",
    title: "Answers instantly",
    body: "Ask about a balance, a reward, or a nearby store and get an answer right away, no waiting on hold.",
    tone: "surface",
  },
] as const;

export default function ConsumersPage() {
  return (
    <main>
      {/* HERO: coral band, single column, no split (differs from landing's split hero) */}
      <section className="bg-primary py-20 text-on-primary md:py-28">
        <div className="mx-auto max-w-6xl px-4">
          <Reveal>
            <p className="text-label-l uppercase tracking-wide text-on-primary/80">For every regular customer</p>
            <h1 className="mt-4 max-w-2xl text-display-s md:text-display-m">Every suki card, one app.</h1>
            <p className="mt-5 max-w-lg text-body-l text-on-primary/90">
              Scan your receipts at the stores you love and watch every point, stamp, and reward sync automatically.
            </p>
            <Link href="/home" className={buttonVariants({ variant: "elevated", size: "touch" }) + " mt-8"}>
              Open Giya
            </Link>
          </Reveal>
        </div>
      </section>

      {/* BENEFITS: 2x2 asymmetric grid, mango only on the reward figure */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <Reveal>
          <h2 className="max-w-lg text-headline-l">Everything your loyalty cards should do</h2>
        </Reveal>
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          {BENEFITS.map((b, i) => (
            <Reveal key={b.title} delay={i * 0.06}>
              <div
                className={
                  b.tone === "container"
                    ? "flex h-full flex-col gap-4 rounded-md3-xl bg-primary-container p-8 text-on-primary-container"
                    : "flex h-full flex-col gap-4 rounded-md3-xl bg-surface-container p-8 text-on-surface"
                }
              >
                <span aria-hidden className="material-symbols-rounded text-3xl">
                  {b.icon}
                </span>
                <h3 className="text-title-l">{b.title}</h3>
                <p className={b.tone === "container" ? "text-body-m text-on-primary-container/90" : "text-body-m text-on-surface-variant"}>
                  {b.body}
                </p>
                {b.tone === "reward" && (
                  <span className="mt-1 w-fit rounded-full bg-tertiary-container px-4 py-2 font-mono text-title-m text-on-tertiary-container">
                    500 pts
                  </span>
                )}
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* SEE IT IN ACTION: split, text + PhonePreview */}
      <section className="bg-surface-container-low py-20">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 md:grid-cols-[1fr_1fr]">
          <Reveal>
            <div className="max-w-md">
              <h2 className="text-headline-l">See your wallet, always in view</h2>
              <p className="mt-4 text-body-l text-on-surface-variant">
                Balances, stamps, and rewards update the second a receipt clears, right from your home screen.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.12} className="justify-self-center md:justify-self-end">
            <PhonePreview />
          </Reveal>
        </div>
      </section>

      {/* CLOSING CTA: coral band, mirrors landing's final CTA */}
      <section className="bg-primary py-20 text-on-primary">
        <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 md:flex-row md:items-center md:justify-between">
          <Reveal>
            <h2 className="max-w-xl text-headline-l">Start collecting rewards you will actually use</h2>
          </Reveal>
          <Reveal delay={0.1}>
            <Link href="/home" className={buttonVariants({ variant: "elevated", size: "touch" })}>
              Open Giya
            </Link>
          </Reveal>
        </div>
      </section>
    </main>
  );
}
