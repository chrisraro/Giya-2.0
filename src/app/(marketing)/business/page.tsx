import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Reveal } from "@/components/marketing/reveal";

const TITLE = "Giya for Businesses | Loyalty without the hardware";
const DESCRIPTION =
  "Campaigns, points, rewards, and customer intelligence from the receipts you already print. Register your Philippine SME business.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website" },
};

const PROPS = [
  { icon: "campaign", title: "Campaign engine", body: "Promotions, rewards, and loyalty programs from templates. Schedule them like a social post." },
  { icon: "loyalty", title: "Points and rewards", body: "Set how customers earn, cap what you give away, and validate redemptions with a scan." },
  { icon: "insights", title: "Customer intelligence", body: "See visits, spend, and your regulars by name. Know whether promos actually work." },
  { icon: "power_off", title: "Zero hardware", body: "Your printed receipt is the integration. No POS changes, no tablets, no staff training." },
] as const;

const PILOT_STEPS = [
  { title: "Register", body: "Create your business account in seconds with Email, Google, or Facebook OAuth." },
  { title: "Verify", body: "Submit your business details in the merchant portal for quick platform admin verification." },
  { title: "Launch", body: "Pick a campaign template and go live. Your customers start scanning immediately." },
] as const;

export default function BusinessMarketingPage() {
  return (
    <main>
      <section className="mx-auto max-w-6xl px-4 pb-16 pt-14 md:pt-20">
        <Reveal>
          <div className="max-w-2xl">
            <h1 className="text-display-s">Know your customers. Keep them coming back.</h1>
            <p className="mt-5 max-w-lg text-body-l text-on-surface-variant">
              Giya gives Philippine food and retail SMEs an enterprise-grade loyalty and marketing suite, powered by the receipts you already print.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/business/signup" className={buttonVariants({ variant: "filled", size: "touch" })}>
                Register your business
              </Link>
              <Link href="/business/login" className={buttonVariants({ variant: "outlined", size: "touch" })}>
                Sign in to Portal
              </Link>
            </div>
          </div>
        </Reveal>
      </section>

      <section className="bg-secondary py-20 text-on-secondary">
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
        <Reveal><h2 className="text-headline-l">How merchant onboarding works</h2></Reveal>
        <ol className="mt-10 grid gap-8 md:grid-cols-3">
          {PILOT_STEPS.map((s, i) => (
            <li key={s.title} className="rounded-md3-xl border border-outline-variant p-6">
              <Reveal delay={i * 0.08}>
                <p className="font-mono text-label-l text-secondary">{String(i + 1).padStart(2, "0")}</p>
                <h3 className="mt-2 text-title-l">{s.title}</h3>
                <p className="mt-2 text-body-m text-on-surface-variant">{s.body}</p>
              </Reveal>
            </li>
          ))}
        </ol>
        <Reveal delay={0.2}>
          <div className="mt-12 flex flex-col items-start gap-4 rounded-md3-xl bg-surface-container p-8 md:flex-row md:items-center md:justify-between">
            <p className="max-w-lg text-title-m">Ready to grow your customer loyalty in the Philippines? Get started in under 2 minutes.</p>
            <Link href="/business/signup" className={buttonVariants({ variant: "filled", size: "touch" })}>
              Register business now
            </Link>
          </div>
        </Reveal>
      </section>
    </main>
  );
}
