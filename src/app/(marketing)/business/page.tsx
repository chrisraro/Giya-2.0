import type { Metadata } from "next";
import { buttonVariants } from "@/components/ui/button";
import { Reveal } from "@/components/marketing/reveal";

const TITLE = "Giya for Businesses | Loyalty without the hardware";
const DESCRIPTION =
  "Campaigns, points, rewards, and customer intelligence from the receipts you already print. Join the Giya pilot for Philippine food and retail SMEs.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website" },
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
  { title: "Verify", body: "Submit your permit and business details in the portal. We typically verify within days." },
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
        <Reveal><h2 className="text-headline-l">How the pilot works</h2></Reveal>
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
            <p className="max-w-lg text-title-m">The pilot cohort is small on purpose. If you run a food or retail business in the Philippines, we want to hear from you.</p>
            <a href={MAILTO} className={buttonVariants({ variant: "filled", size: "touch" })}>Join the pilot</a>
          </div>
        </Reveal>
      </section>
    </main>
  );
}
