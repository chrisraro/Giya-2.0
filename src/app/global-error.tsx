"use client";

import * as React from "react";

import "./globals.css";
import { buttonVariants } from "@/components/ui/button";

// The last-resort boundary: it fires only when the ROOT layout itself throws,
// so there is no shell, no ThemeProvider and no fonts to lean on. Next replaces
// the whole document, which is why this renders its own <html><body>.
//
// It stays deliberately dumb: no icon font (not loaded here), no next/link
// (a plain anchor does a full reload, which is what you want after a root
// failure), and only MD3 token classes from globals.css.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[global-error]", error);
    if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
    void import("@sentry/nextjs")
      .then((sentry) => {
        sentry.captureException(error);
      })
      .catch(() => {});
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-surface text-on-surface antialiased">
        <main
          role="alert"
          className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 py-12 text-center"
        >
          <h1 className="text-headline-m">Something went wrong on our side</h1>
          <p className="text-body-m text-balance text-on-surface-variant">
            Giya hit an unexpected problem. Your points and receipts are safe. Try again in a
            moment.
          </p>
          <div className="mt-4 flex w-full flex-col gap-3">
            <button type="button" onClick={reset} className={buttonVariants({ size: "touch" })}>
              Try again
            </button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- full reload is intended */}
            <a href="/" className={buttonVariants({ variant: "outlined", size: "touch" })}>
              Go to Giya home
            </a>
          </div>
          {error.digest ? (
            <p className="text-label-s text-on-surface-variant">Reference: {error.digest}</p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
