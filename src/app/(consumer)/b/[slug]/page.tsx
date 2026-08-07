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
import { getActivePromotionsForBusiness } from "@/features/promotions/server/repo";
import { PromotionCard } from "@/features/promotions/components/promotion-card";
import { isFavorite } from "@/features/favorites/server/repo";
import { FavoriteButton } from "@/features/favorites/components/favorite-button";

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

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [menuGroups, rewards, balance, promotions, isFav] = await Promise.all([
    getPublicMenu(business.id),
    getPublicRewards(business.id),
    user
      ? getMyBalanceForBusiness(business.id, user.id).catch((error: unknown) => {
          console.error(
            `[rewards] failed to load balance for business ${business.id}, rendering the catalogue without affordability`,
            error,
          );
          return null;
        })
      : Promise.resolve(null),
    getActivePromotionsForBusiness(business.id).catch(() => []),
    isFavorite(business.id).catch(() => false),
  ]);

  const rewardAffordability =
    balance !== null
      ? affordability(
          balance,
          rewards.map((reward) => ({ rewardId: reward.id, name: reward.name, pointsCost: reward.pointsCost })),
        )
      : null;
  const affordabilityByRewardId = rewardAffordability
    ? new Map(rewardAffordability.rewards.map((r) => [r.rewardId, r]))
    : null;

  const hoursSummary = formatHoursSummary(business.openingHours);
  const caption = [business.businessTypeName, business.cityName].filter(Boolean).join(" · ");

  return (
    <main className="mx-auto max-w-md pb-32">
      <div className="relative h-40 w-full overflow-hidden bg-surface-container sm:h-48">
        {business.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={business.coverUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-primary to-primary-container" />
        )}
      </div>

      <div className="px-4">
        <div className="relative z-10 -mt-10 flex items-end justify-between gap-3">
          <div className="size-20 shrink-0 overflow-hidden rounded-full bg-surface-container-highest ring-4 ring-surface">
            {business.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={business.logoUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-primary-container text-headline-s text-on-primary-container">
                {business.name.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          {user ? <FavoriteButton businessId={business.id} initialIsFavorite={isFav} /> : null}
        </div>

        <h1 className="mt-3 text-headline-s text-on-surface">{business.name}</h1>
        {caption ? <p className="mt-0.5 text-body-s text-on-surface-variant">{caption}</p> : null}
        {business.description ? (
          <p className="mt-2 text-body-m text-on-surface-variant">{business.description}</p>
        ) : null}
        <p className="mt-2 text-label-l text-primary">{hoursSummary}</p>
      </div>

      {promotions.length > 0 ? (
        <div className="mt-6 px-4">
          <h2 className="text-title-l text-on-surface">Active Promotions</h2>
          <div className="mt-3 flex flex-col gap-3">
            {promotions.map((promo) => (
              <PromotionCard key={promo.id} promotion={promo} />
            ))}
          </div>
        </div>
      ) : null}

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
                  <div aria-disabled={!affordable}>
                    <div className="flex items-start justify-between gap-3">
                      <p className={cn("text-title-m", affordable ? "text-on-surface" : "text-on-surface-variant")}>
                        {reward.name}
                      </p>
                      <Badge
                        className={cn(
                          "shrink-0",
                          !affordable && "bg-surface-variant text-on-surface-variant",
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

      <BusinessLocation
        name={business.name}
        addressText={business.addressText}
        coordinates={business.coordinates}
      />

      <div className="mt-6 px-4">
        <PublicMenu groups={menuGroups} />
      </div>

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
