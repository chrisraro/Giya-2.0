"use client";

import Script from "next/script";
import { useEffect, useRef } from "react";

import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { META_GRAPH_VERSION } from "@/lib/integrations/meta-version";
import { cn } from "@/lib/utils";

// A business's Facebook Page, shown with Facebook's Page Plugin.
//
// The Page Plugin is Facebook's review-free embed: the SDK turns the `fb-page`
// element below into an iframe of the Page's public timeline. It replaced the
// earlier Meta oEmbed Read path (dropped 2026-10: oEmbed Read needs App Review,
// returns the same widget, and added nothing a customer could see). The element
// is built as JSX from a URL that already passed toFacebookPageUrl's https +
// host allowlist - no HTML from anywhere is injected.
//
// The SDK is loaded once per page (next/script dedupes by id) and `xfbml=1`
// parses the element on load. A client-side navigation onto a second Page
// finds the SDK already loaded and never re-parses, hence the explicit
// XFBML.parse in the effect.

declare global {
  interface Window {
    FB?: { XFBML: { parse: (element?: Element) => void } };
  }
}

export interface FacebookPageEmbedProps {
  /** Must already have passed toFacebookPageUrl. */
  pageUrl: string;
  /** Giya's Meta app id (public), so the SDK attributes the plugin to our app. */
  appId?: string | null;
  className?: string;
}

export function FacebookPageEmbed({ pageUrl, appId, className }: FacebookPageEmbedProps) {
  const pluginRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pluginRef.current !== null) {
      window.FB?.XFBML.parse(pluginRef.current);
    }
  }, [pageUrl]);

  return (
    <Card variant="outlined" className={cn("p-4", className)}>
      <h2 className="text-title-m text-on-surface">Facebook</h2>
      <div id="fb-root" />
      <div ref={pluginRef} data-testid="facebook-page-plugin" className="mt-3 overflow-hidden">
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
      <Script
        id="facebook-jssdk"
        src={`https://connect.facebook.net/en_US/sdk.js#xfbml=1&version=${META_GRAPH_VERSION}${appId ? `&appId=${encodeURIComponent(appId)}` : ""}`}
        strategy="lazyOnload"
        crossOrigin="anonymous"
      />
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
