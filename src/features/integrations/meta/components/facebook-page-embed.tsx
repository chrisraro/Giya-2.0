"use client";

import Script from "next/script";
import { useEffect, useRef } from "react";

import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { META_GRAPH_VERSION } from "@/lib/integrations/meta-version";
import { cn } from "@/lib/utils";

// A Facebook Page rendered from Meta oEmbed Read HTML.
//
// Synchronous on purpose: the server fetches `html` (getFacebookPageEmbed) and
// passes it in, so this works in any tree and the token never nears the client.
//
// The HTML is rendered UNMODIFIED. It is Meta's markup from graph.facebook.com
// for an allowlisted facebook.com URL, Meta's terms require displaying it as
// returned, and a sanitizer strips exactly the `fb-page` attributes the SDK
// needs, leaving an empty box.
//
// The request used `omitscript=true`, so the SDK is loaded here, once per
// page: next/script dedupes by id, and `xfbml=1` parses the embed on load. A
// client-side navigation onto a second embed finds the SDK already loaded and
// never re-parses, hence the explicit XFBML.parse in the effect.

declare global {
  interface Window {
    FB?: { XFBML: { parse: (element?: Element) => void } };
  }
}

export interface FacebookPageEmbedProps {
  /** oEmbed HTML, or null when it could not be fetched - the link still renders. */
  html: string | null;
  pageUrl: string;
  className?: string;
}

export function FacebookPageEmbed({ html, pageUrl, className }: FacebookPageEmbedProps) {
  const embedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (html !== null && embedRef.current !== null) {
      window.FB?.XFBML.parse(embedRef.current);
    }
  }, [html]);

  return (
    <Card variant="outlined" className={cn("p-4", className)}>
      <h2 className="text-title-m text-on-surface">Facebook</h2>
      <div id="fb-root" />
      {html !== null ? (
        <>
          <div
            ref={embedRef}
            data-testid="facebook-page-embed"
            className="mt-3 overflow-hidden"
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <Script
            id="facebook-jssdk"
            src={`https://connect.facebook.net/en_US/sdk.js#xfbml=1&version=${META_GRAPH_VERSION}`}
            strategy="lazyOnload"
            crossOrigin="anonymous"
          />
        </>
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
