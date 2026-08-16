import Link from "next/link";
import { redirect } from "next/navigation";

import { Logo } from "@/components/brand/logo";
import { BusinessCard } from "@/components/consumer/business-card";
import { EmptyState } from "@/components/consumer/empty-state";
import { LoyaltyStrip } from "@/components/consumer/loyalty-strip";
import { Card } from "@/components/ui/card";
import { listActiveBusinesses } from "@/features/businesses/server/public-repo";
import { firstNameFrom } from "@/features/identity/display-name";
import { getMyConsumerProfile } from "@/features/identity/server/repo";
import { NotificationBell } from "@/features/notifications/components/notification-bell";
import { getMyUnreadNotificationCount } from "@/features/notifications/server/repo";
import { getMyBalances } from "@/features/rewards/server/repo";
import { filipinoGreeting, manilaDateCaption } from "@/lib/greeting";
import { listPublicPromotions } from "@/features/promotions/server/repo";
import { PromotionCard } from "@/features/promotions/components/promotion-card";
import { FavoritesRail } from "@/features/favorites/components/favorites-rail";
import { listMyFavorites } from "@/features/favorites/server/repo";
import { HOME_DISCOVER_FETCH, HOME_DISCOVER_LIMIT, HOME_FAVORITES_LIMIT } from "./limits";

// Every read on this page is RLS-scoped to the signed-in consumer or is the
// public business catalog, and the greeting depends on the current Manila hour,
// so nothing here is cacheable across requests or across people.
export const dynamic = "force-dynamic";


export default async function HomePage() {
  const profile = await getMyConsumerProfile();
  if (!profile) redirect(`/login?next=${encodeURIComponent("/home")}`);

  const [balances, activeBusinesses, unreadNotifications, promotions, favorites] =
    await Promise.all([
      getMyBalances(),
      listActiveBusinesses({ limit: HOME_DISCOVER_FETCH }),
      getMyUnreadNotificationCount(),
      listPublicPromotions(5).catch(() => []),
      // THE RAIL DEGRADES; THE PAGE DOES NOT FAIL.
      //
      // `listMyFavorites` throws on a query error rather than returning [],
      // deliberately (see the comment on it, and the same call in
      // rewards/loyalty repos). That hands this page the choice, and this page
      // takes the rail down rather than itself: /home's job is the points
      // total, the balance strip and the discover grid, none of which has
      // anything to do with favourites, and losing the whole first screen after
      // sign-in over an accelerator is the worse outcome. The same read on
      // /favorites is NOT caught, because there the list is the page and the
      // empty state would be a lie about the consumer's own data.
      //
      // Logged rather than swallowed: a rail that quietly stops appearing is
      // otherwise indistinguishable from a consumer who saved nothing, which is
      // the exact confusion the throw exists to prevent.
      listMyFavorites().catch((error: unknown) => {
        console.error("[home] favourites rail read failed; rendering /home without it", error);
        return [];
      }),
    ]);

  const now = new Date();
  const firstName = firstNameFrom(profile.displayName);
  const greeting = filipinoGreeting(now);
  const totalPoints = balances.reduce((sum, balance) => sum + balance.pointsBalance, 0);

  const railFavorites = favorites.slice(0, HOME_FAVORITES_LIMIT);

  const collectedIds = new Set(balances.map((balance) => balance.businessId));
  const discover = activeBusinesses
    .filter((business) => !collectedIds.has(business.id))
    .slice(0, HOME_DISCOVER_LIMIT);
  // No shops at all on the platform is a different thing to say than "you are
  // already on every shop we have", and only the first one gets an empty state.
  const noShopsOnGiya = activeBusinesses.length === 0;

  return (
    <main className="mx-auto max-w-md px-4 pt-6">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-headline-s text-on-surface">
            {firstName ? `${greeting}, ${firstName}` : greeting}
          </p>
          <p className="mt-0.5 text-body-s text-on-surface-variant">{manilaDateCaption(now)}</p>
        </div>
        {/* The inbox affordance lives here rather than in the bottom nav: that
            row is full at MD3's five destinations (see notification-bell.tsx
            and bottom-nav.tsx), and an unread badge has to be visible on a
            screen that is NOT the inbox to do its job. Home is the first screen
            after sign-in and the one a consumer opens asking exactly what this
            badge answers. */}
        <div className="flex shrink-0 items-center gap-1">
          <NotificationBell unreadCount={unreadNotifications} />
          <Logo variant="mark" className="shrink-0 text-primary" />
        </div>
      </header>

      {balances.length === 0 ? (
        <EmptyState
          icon="loyalty"
          title="No points yet"
          body="Points land here once you scan a receipt from a shop on Giya. Pick the shop you paid at, snap the receipt, and the points follow."
          action={{ label: "Scan a receipt", href: "/scan" }}
          className="mt-6"
        />
      ) : (
        <>
          <Card variant="filled" className="mt-6 bg-primary-container p-5">
            <p className="text-label-l text-on-primary-container">Total points</p>
            <p className="mt-1 font-mono text-headline-m text-on-primary-container">
              {totalPoints.toLocaleString()}
            </p>
            <p className="mt-1 text-body-s text-on-primary-container">
              across {balances.length} {balances.length === 1 ? "business" : "businesses"}
            </p>
          </Card>

          <section className="mt-8">
            <h2 className="sr-only">Your balances</h2>
            <LoyaltyStrip balances={balances} />
          </section>
        </>
      )}

      {/* Nothing at all when the consumer has saved nothing. A heading over an
          empty row would be a section telling them about a feature rather than
          giving them their shops, and /favorites already owns the "here is how
          to save one" empty state. */}
      {railFavorites.length > 0 ? (
        <section className="mt-8">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-title-m text-on-surface">Your favorites</h2>
            <Link
              href="/favorites"
              className="shrink-0 rounded-md3-xs text-label-l text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary"
            >
              See all favorites
            </Link>
          </div>
          <div className="mt-3">
            <FavoritesRail favorites={railFavorites} />
          </div>
        </section>
      ) : null}

      {promotions.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-title-m text-on-surface">Featured Promotions</h2>
          <div className="mt-3 flex flex-col gap-3">
            {promotions.map((promo) => (
              <PromotionCard key={promo.id} promotion={promo} />
            ))}
          </div>
        </section>
      ) : null}

      {discover.length > 0 || noShopsOnGiya ? (
        <section className="mt-8 pb-8">
          {/* Not "Near you": there is no geolocation anywhere in this app, and
              the heading it replaces sat above fixture distances in km. */}
          <h2 className="text-title-m text-on-surface">Shops on Giya</h2>
          {noShopsOnGiya ? (
            <EmptyState
              icon="storefront"
              title="No shops yet"
              body="No shops are live on Giya right now. As soon as one joins, you will be able to earn points on their receipts."
              className="mt-3"
            />
          ) : (
            <div className="mt-3 space-y-3">
              {discover.map((business) => (
                <BusinessCard key={business.id} business={business} />
              ))}
            </div>
          )}
        </section>
      ) : null}
    </main>
  );
}
