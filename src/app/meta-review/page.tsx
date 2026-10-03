import type { Metadata } from "next";

import { FacebookPageEmbed } from "@/features/integrations/meta/components/facebook-page-embed";
import { getFacebookPageEmbed, getMetaAppIdForSdk } from "@/lib/integrations/meta-oembed";

// /meta-review - the page Meta App Review opens to verify oEmbed Read.
//
// Meta requires a URL on OUR site that shows Meta-owned content embedded via
// oEmbed Read, reachable without logging in. It renders Meta's own Facebook
// Page through the SAME component every public business profile (/b/[slug])
// uses for that business's Page, so what the reviewer sees is the production
// code path, not a mock.
//
// Public by construction: it lives outside every route group with an auth
// layout, and src/proxy.ts gates only the onboarding, /business/*,
// /admin and listed consumer routes. Not linked from any nav, and noindex.

const META_PAGE_URL = "https://www.facebook.com/Meta";

// The fetch itself is cached for a day; the page re-renders hourly so a
// transient Meta failure does not leave the review page empty for long.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Facebook Page embeds | Giya",
  description: "How Giya displays public Facebook Pages using Meta oEmbed Read.",
  robots: { index: false, follow: false },
  openGraph: {
    title: "Facebook Page embeds | Giya",
    description: "How Giya displays public Facebook Pages using Meta oEmbed Read.",
    type: "website",
  },
};

export default async function MetaReviewPage() {
  const embed = await getFacebookPageEmbed(META_PAGE_URL);

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-headline-s text-on-surface">Facebook Page embeds on Giya</h1>
      <p className="mt-3 text-body-m text-on-surface-variant">
        Giya shows a business&apos;s public Facebook Page on its Giya profile so customers can see the
        shop&apos;s latest posts. Below, the same component displays Meta&apos;s official Facebook Page;
        on each business profile it shows that business&apos;s own Page instead.
        {/* Claimed only when true: in the pending-review state the note below explains instead. */}
        {embed.status === "ok"
          ? " This card is rendered from the embed HTML our server retrieves from Meta's oEmbed Read endpoint."
          : null}
      </p>
      {embed.status === "pending_review" ? (
        // Stated on the page, not only in the submission notes: the reviewer
        // should never have to guess which mechanism drew the card.
        <p data-testid="pending-review-note" className="mt-3 text-body-s text-on-surface-variant">
          Giya&apos;s oEmbed Read access is awaiting Meta App Review, and until it is approved
          Meta&apos;s oEmbed endpoint declines our request. Meanwhile this card shows the same Page
          through Facebook&apos;s Page Plugin. Once approved, it renders the embed returned by oEmbed
          Read with no further change.
        </p>
      ) : null}
      <FacebookPageEmbed embed={embed} pageUrl={META_PAGE_URL} appId={getMetaAppIdForSdk()} className="mt-6" />
    </main>
  );
}
