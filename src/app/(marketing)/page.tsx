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
    </main>
  );
}
