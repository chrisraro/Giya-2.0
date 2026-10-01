"use client";

import Script from "next/script";
import { useEffect, useRef } from "react";

import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { FacebookPageEmbed as FacebookPageEmbedResult } from "@/lib/integrations/meta-oembed";
import { META_GRAPH_VERSION } from "@/lib/integrations/meta-version";
import { cn } from "@/lib/utils";

// A Facebook Page rendered from Meta oEmbed Read HTML.
//
// Synchronous on purpose: the server fetches the embed (getFacebookPageEmbed)
// and passes the result in, so the token never nears the client.
//
// `ok`: Meta's HTML is rendered UNMODIFIED. It comes from graph.facebook.com
// for an allowlisted facebook.com URL, Meta's terms require displaying it as
// returned, and a sanitizer strips exactly the `fb-page` attributes the SDK
// needs, leaving an empty box.
//
// `pending_review`: Meta refuses oEmbed Read until App Review approves it, and
// the review needs the embed visible on our site - a loop. The Page Plugin
// (Facebook's review-free embed, the same `fb-page` element oEmbed returns) is
// rendered instead, built here as JSX from the allowlisted URL rather than as
// injected HTML. The day approval lands, `ok` replaces it with no code change.
//
// `unavailable`: only the link.
//
// The SDK is loaded once per page (next/script dedupes by id) and `xfbml=1`
// parses the element on load. A client-side navigation onto a second embed
// finds the SDK already loaded and never re-parses, hence the explicit
// XFBML.parse in the effect.

declare global {
  interface Window {
    FB?: { XFBML: { parse: (element?: Element) => void } };
  }
}

export interface FacebookPageEmbedProps {
  embed: FacebookPageEmbedResult;
  /** Must already have passed toFacebookPageUrl. */
  pageUrl: string;
  /** Giya's Meta app id (public), so the SDK attributes the embed to our app. */
  appId?: string | null;
  className?: string;
}

export function FacebookPageEmbed({ embed, pageUrl, appId, className }: FacebookPageEmbedProps) {
  const embedRef = useRef<HTMLDivElement>(null);
  const showsPage = embed.status !== "unavailable";

  useEffect(() => {
    if (showsPage && embedRef.current !== null) {
      window.FB?.XFBML.parse(embedRef.current);
    }
  }, [showsPage, embed]);

  return (
    <Card variant="outlined" className={cn("p-4", className)}>
      <h2 className="text-title-m text-on-surface">Facebook</h2>
      <div id="fb-root" />
      {embed.status === "ok" ? (
        <div
          ref={embedRef}
          data-testid="facebook-page-embed"
          className="mt-3 overflow-hidden"
          dangerouslySetInnerHTML={{ __html: embed.html }}
        />
      ) : null}
      {embed.status === "pending_review" ? (
        <div ref={embedRef} data-testid="facebook-page-plugin" className="mt-3 overflow-hidden">
          <div
            className="fb-page"
            data-href={pageUrl}
            data-tabs="timeline"
            data-width="500"
            data-adapt-container-width="true"
            data-show-facepile="false"
          >
            <blockquote cite={pageUrl} className="fb-xfbml-parse-ignore">
              <a href={pageUrl}>Facebook Page</a>
            </blockquote>
          </div>
        </div>
      ) : null}
      {showsPage ? (
        <Script
          id="facebook-jssdk"
          src={`https://connect.facebook.net/en_US/sdk.js#xfbml=1&version=${META_GRAPH_VERSION}${appId ? `&appId=${encodeURIComponent(appId)}` : ""}`}
          strategy="lazyOnload"
          crossOrigin="anonymous"
        />
      ) : null}
      <a
        href={pageUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(buttonVariants({ variant: "outlined" }), "mt-3 w-full")}
      >
        Visit Facebook Page
      </a>
    </Card>
  );
}
