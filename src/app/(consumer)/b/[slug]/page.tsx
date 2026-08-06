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

// Public menu data changes at merchant pace, not per-request, which is the
// intent behind this 60s revalidate window - but note it is NOT actually
// serving from a static/ISR cache today. Every `public-repo.ts` read already
// calls the shared `createClient()`, which reads `cookies()` (for the anon
// Supabase session) - a dynamic API that opts the whole route into per-
// request rendering regardless of this export. This task adds a SECOND
// per-user cookie read (the viewer's own session, for the balance lookup
// below), which only deepens that: there is no version of this page a
// signed-in viewer's balance can safely be ISR-cached across, so removing
// this export entirely would be more honest than fixing the number - kept as
// a "this is the intended cost, not a bug" marker rather than removed outright.
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
    // getMyBalanceForBusiness is filtered on the VIEWER's own consumer id, not
    // business_id alone (task-5 review I1): business_customers_staff_select
    // grants owner/manager/marketing staff SELECT over every customer row at
    // their own business, so business_id alone could return a stranger's
    // balance to a staff member browsing their own /b/[slug].
    //
    // getMyBalanceForBusiness now throws on a genuine query error rather than
    // answering null for it (same I1 fix). This page has no error.tsx (the
    // app has none at all), so an uncaught throw here would lose the menu,
    // hours, location and Scan CTA too - on a public marketing page, over a
    // balance that is a garnish. Chosen fix (reviewer's stated preference):
    // fail SOFT, degrading to `null` (the same shape as "signed out" / "no
    // relationship row yet") rather than adding a scoped boundary - never
    // fabricate a shortfall from a read that never actually completed.
    user
      ? getMyBalanceForBusiness(business.id, user.id).catch((error: unknown) => {
          console.error(
            `[rewards] failed to load balance for business ${business.id}, rendering the catalogue without affordability`,
            error,
          );
          return null;
        })
      : Promise.resolve(null),
  ]);
  // null means either "signed out" or "signed in but no business_customers
  // row here yet" (never earned at this business) - both read as "no
  // affordability fact to render" (product call, task-5 review): a brand-new
  // visitor's whole catalogue should look like the signed-out view, not a
  // wall of unaffordable grey. A REAL row holding exactly 0 points is a
  // different, later state (`balance === 0`, not `null`) and still gets the
  // full treatment below.
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
                      per spec (jsx-a11y/role-supports-aria-props), but a plain div
                      has no implicit role and can carry it. It has no live effect
                      on assistive tech either way (role=generic) - present because
                      the brief asks for it, not because it announces anything on
                      its own; the visible shortfall text is the real signal here
                      (there is no button to disable on this read-only catalogue
                      view). */}
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
