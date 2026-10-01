import type { Metadata } from "next";

import { FacebookPageEmbed } from "@/features/integrations/meta/components/facebook-page-embed";
import { getFacebookPageEmbed } from "@/lib/integrations/meta-oembed";

// /meta-review - the page Meta App Review opens to verify oEmbed Read.
//
// Meta requires a URL on OUR site that shows Meta-owned content embedded via
// oEmbed Read, reachable without logging in. It renders Meta's own Facebook
// Page through the SAME component every public business profile (/b/[slug])
// uses for that business's Page, so what the reviewer sees is the production
// code path, not a mock.
//
// Public by construction: it lives outside every route group with an auth
// layout, and src/middleware.ts gates only the onboarding, /business/*,
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
  const html = await getFacebookPageEmbed(META_PAGE_URL);

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-headline-s text-on-surface">Facebook Page embeds on Giya</h1>
      <p className="mt-3 text-body-m text-on-surface-variant">
        Giya shows a business&apos;s public Facebook Page on its Giya profile so customers can see the
        shop&apos;s latest posts. Below, the same component displays Meta&apos;s official Facebook Page,
        rendered from embed HTML our server retrieves from Meta&apos;s oEmbed Read endpoint. On each
        business profile it shows that business&apos;s own Page instead.
      </p>
      <FacebookPageEmbed html={html} pageUrl={META_PAGE_URL} className="mt-6" />
    </main>
  );
}
