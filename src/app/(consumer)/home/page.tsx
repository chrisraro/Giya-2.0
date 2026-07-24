import { Logo } from "@/components/brand/logo";
import { Card } from "@/components/ui/card";
import { LoyaltyStrip } from "@/components/consumer/loyalty-strip";
import { BusinessCard } from "@/components/consumer/business-card";
import { MOCK_USER, MOCK_BALANCES, MOCK_BUSINESSES } from "@/lib/mock/consumer"; // TODO(api): replace mock

// Rendered per-request so the greeting date is always current (Manila time).
export const dynamic = "force-dynamic";

export default function HomePage() {
  // TODO(api): replace mock: fetch signed-in user, balances, and nearby businesses
  const todayCaption = new Intl.DateTimeFormat("en-PH", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Manila",
  }).format(new Date());
  const totalPoints = MOCK_BALANCES.reduce((sum, balance) => sum + balance.points, 0);

  return (
    <main className="mx-auto max-w-md px-4 pt-6">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-headline-s text-on-surface">
            Magandang umaga, {MOCK_USER.firstName}
          </p>
          <p className="mt-0.5 text-body-s text-on-surface-variant">{todayCaption}</p>
        </div>
        <Logo variant="mark" className="text-primary" />
      </header>

      <Card variant="filled" className="mt-6 bg-primary-container p-5">
        <p className="text-label-l text-on-primary-container">Total points</p>
        <p className="mt-1 font-mono text-headline-m text-on-primary-container">
          {totalPoints.toLocaleString()}
        </p>
        <p className="mt-1 text-body-s text-on-primary-container">
          across {MOCK_BALANCES.length} businesses
        </p>
      </Card>

      <section className="mt-8">
        <LoyaltyStrip balances={MOCK_BALANCES} />
      </section>

      <section className="mt-8 pb-8">
        <h2 className="text-title-m text-on-surface">Near you</h2>
        <div className="mt-3 space-y-3">
          {MOCK_BUSINESSES.map((business) => (
            <BusinessCard key={business.id} business={business} />
          ))}
        </div>
      </section>
    </main>
  );
}
