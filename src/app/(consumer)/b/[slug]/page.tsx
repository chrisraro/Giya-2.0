import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { affordability } from "@/features/rewards/affordability";
import { BusinessLocation } from "@/features/businesses/components/business-location";
import { getBusinessBySlug, getPublicMenu, getPublicRewards } from "@/features/businesses/server/public-repo";
import { RewardProgress } from "@/features/rewards/components/reward-progress";
import { RewardShortfall } from "@/features/rewards/components/reward-shortfall";
import { getMyBalanceForBusiness } from "@/features/rewards/server/repo";
import { PublicMenu } from "@/features/menu/components/public-menu";
import { createClient } from "@/lib/supabase/server";
import { formatHoursSummary } from "@/lib/hours";

// Public menu data changes at merchant pace, not per-request - a 60s ISR
// window keeps the page fast without needing manual revalidation wiring.
export const revalidate = 60;

type PageParams = { slug: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<PageParams>;
}): Promise<Metadata> {
  const { slug } = await params;
  const business = await getBusinessBySlug(slug);

  if (!business) {
    return { title: "Business not found | Giya" };
  }

  return {
    title: `${business.name} | Giya`,
    description:
      business.description ?? `See ${business.name}'s menu and loyalty rewards on Giya.`,
  };
}

export default async function PublicBusinessPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { slug } = await params;
  const business = await getBusinessBySlug(slug);

  if (!business) notFound();

  // A signed-out visitor is the common case for this public page, and
  // business_customers_consumer_select only grants to `authenticated` - so
  // that visitor's balance query could never resolve anyway. Checking here
  // avoids sending a query that only ever answers null, and it is what tells
  // the affordability treatment below to render nothing extra rather than
  // guessing a stranger's balance is 0.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [menuGroups, rewards, balance] = await Promise.all([
    getPublicMenu(business.id),
    getPublicRewards(business.id),
    user ? getMyBalanceForBusiness(business.id) : Promise.resolve(null),
  ]);
  // null from getMyBalanceForBusiness means "no business_customers row yet",
  // which for a signed-in viewer reads as 0 points here (never earned at
  // this business), not "no balance context" - that distinction is what
  // `hasBalanceContext` below actually carries.
  const hasBalanceContext = user !== null;
  const rewardAffordability = hasBalanceContext
    ? affordability(
        balance ?? 0,
        rewards.map((reward) => ({ rewardId: reward.id, name: reward.name, pointsCost: reward.pointsCost })),
      )
    : null;
  const affordabilityByRewardId = rewardAffordability
    ? new Map(rewardAffordability.rewards.map((r) => [r.rewardId, r]))
    : null;

  const hoursSummary = formatHoursSummary(business.openingHours);
  const caption = [business.businessTypeName, business.cityName].filter(Boolean).join(" · ");

  return (
    // Bottom padding clears the sticky Scan CTA below, which sits above the
    // consumer shell's bottom nav.
    <main className="mx-auto max-w-md pb-32">
      <div className="relative h-40 w-full overflow-hidden bg-surface-container sm:h-48">
        {business.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- external merchant-hosted image, next/image domain allowlisting not set up for this slice
          <img src={business.coverUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-primary to-primary-container" />
        )}
      </div>

      <div className="px-4">
        {/* relative + z-10 is load-bearing: the cover above is `relative`, and a
            positioned element paints above a non-positioned in-flow sibling
            regardless of DOM order. Without this the avatar's overlapping top
            half renders behind the cover and the logo appears sliced in half. */}
        <div className="relative z-10 -mt-10 flex items-end gap-3">
          <div className="size-20 shrink-0 overflow-hidden rounded-full bg-surface-container-highest ring-4 ring-surface">
            {business.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- external merchant-hosted image, next/image domain allowlisting not set up for this slice
              <img src={business.logoUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-primary-container text-headline-s text-on-primary-container">
                {business.name.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
        </div>

        <h1 className="mt-3 text-headline-s text-on-surface">{business.name}</h1>
        {caption ? <p className="mt-0.5 text-body-s text-on-surface-variant">{caption}</p> : null}
        {business.description ? (
          <p className="mt-2 text-body-m text-on-surface-variant">{business.description}</p>
        ) : null}
        <p className="mt-2 text-label-l text-primary">{hoursSummary}</p>
      </div>

      {rewards.length > 0 ? (
        <div className="mt-6 px-4">
          <h2 className="text-title-l text-on-surface">Rewards</h2>
          {rewardAffordability?.progress ? (
            <RewardProgress
              current={rewardAffordability.progress.current}
              target={rewardAffordability.progress.target}
              rewardName={rewardAffordability.progress.rewardName}
              className="mt-2"
            />
          ) : null}
          <ul className="mt-3 flex flex-col gap-3">
            {rewards.map((reward) => {
              const info = affordabilityByRewardId?.get(reward.id);
              const affordable = info?.affordable ?? true;

              return (
                <li key={reward.id} className="rounded-md3-md border border-outline-variant bg-surface p-4">
                  {/* aria-disabled lives on this wrapper, not the <li>: "listitem"
                      is an implicit ARIA role that does not support aria-disabled
                      per spec (jsx-a11y/role-supports-aria-props), but a plain
                      div has no implicit role and can carry it. */}
                  <div aria-disabled={!affordable}>
                    <div className="flex items-start justify-between gap-3">
                      <p className={cn("text-title-m", affordable ? "text-on-surface" : "text-on-surface-variant")}>
                        {reward.name}
                      </p>
                      <Badge
                        className={cn(
                          "shrink-0",
                          !affordable && "bg-surface-container-high text-on-surface-variant",
                        )}
                      >
                        {reward.pointsCost} pts
                      </Badge>
                    </div>
                    {reward.description ? (
                      <p className="mt-1 text-body-s text-on-surface-variant">{reward.description}</p>
                    ) : null}
                    {!affordable && info ? <RewardShortfall shortfall={info.shortfall} className="mt-2" /> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Between the rewards and the menu on purpose. Rewards are why a
          consumer opened the page, location is what they act on next, and the
          menu is the long scroll that everything else would sit below. The
          block renders nothing at all when the merchant has neither an address
          nor a pin, so a bare profile does not grow an empty heading. */}
      <BusinessLocation
        name={business.name}
        addressText={business.addressText}
        coordinates={business.coordinates}
      />

      <div className="mt-6 px-4">
        <PublicMenu groups={menuGroups} />
      </div>

      {/* Doc 33's business-page Scan CTA. The business id travels in the link,
          so doc 36 Stage 5 verifies a merchant the consumer already chose
          instead of inferring one from OCR text. Primary, not tertiary: mango
          is reserved for rewards language and the shell's Scan FAB. */}
      <div className="fixed inset-x-0 bottom-24 z-30 px-4">
        <div className="mx-auto max-w-md">
          <Link
            href={`/scan?business=${business.id}`}
            className={cn(
              buttonVariants({ variant: "filled", size: "touch" }),
              "w-full shadow-lg",
            )}
          >
            <span aria-hidden className="material-symbols-rounded">
              document_scanner
            </span>
            Scan receipt
          </Link>
        </div>
      </div>
    </main>
  );
}
