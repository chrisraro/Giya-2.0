import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getBusinessBySlug, getPublicMenu } from "@/features/businesses/server/public-repo";
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

  const categories = await getPublicMenu(business.id);
  const hoursSummary = formatHoursSummary(business.openingHours);
  const caption = [business.businessTypeName, business.cityName].filter(Boolean).join(" · ");

  return (
    <main className="mx-auto max-w-md pb-8">
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

      <div className="mt-6 px-4">
        <PublicMenu categories={categories} />
      </div>
    </main>
  );
}
