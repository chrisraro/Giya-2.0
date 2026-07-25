import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getBusinessBySlug, getPublicMenu, getPublicRewards } from "@/features/businesses/server/public-repo";
import { PublicMenu } from "@/features/menu/components/public-menu";
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

  const [menuGroups, rewards] = await Promise.all([
    getPublicMenu(business.id),
    getPublicRewards(business.id),
  ]);
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
        <div className="-mt-10 flex items-end gap-3">
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
          <ul className="mt-3 flex flex-col gap-3">
            {rewards.map((reward) => (
              <li
                key={reward.id}
                className="rounded-md3-md border border-outline-variant bg-surface p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-title-m text-on-surface">{reward.name}</p>
                  <Badge className="shrink-0">{reward.pointsCost} pts</Badge>
                </div>
                {reward.description ? (
                  <p className="mt-1 text-body-s text-on-surface-variant">{reward.description}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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
