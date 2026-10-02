"use client";

import Link from "next/link";
import * as React from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface RouteErrorProps {
  /** Next's boundary props. `digest` is the server-side log correlation id. */
  error: Error & { digest?: string };
  reset: () => void;
  homeHref: string;
  homeLabel: string;
  className?: string;
}

/**
 * Report a boundary-caught error once, through the path that exists today.
 *
 * `instrumentation-client.ts` only initialises `@sentry/nextjs` when
 * NEXT_PUBLIC_SENTRY_DSN is set, and with no DSN the SDK is never imported.
 * This follows the same rule: the import is dynamic and sits behind the same
 * check, so the disabled path costs nothing. `console.error` always runs so a
 * developer (or the browser's own log capture) still sees the failure.
 */
function reportError(error: Error & { digest?: string }): void {
  console.error("[route-error]", error);

  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  void import("@sentry/nextjs")
    .then((sentry) => {
      sentry.captureException(error);
    })
    .catch(() => {
      // Crash reporting must never be the reason the error screen fails.
    });
}

/**
 * The shared body of every `error.tsx` route boundary.
 *
 * WHY IT NEVER SHOWS error.message: in production Next already strips server
 * messages, but client-thrown errors keep theirs, and a raw message can carry
 * SQL, ids or stack hints. The user gets a fixed sentence plus `digest`, a
 * reference code support can match to the server log line.
 */
export function RouteError({ error, reset, homeHref, homeLabel, className }: RouteErrorProps) {
  // Keyed on `error` so a re-render with the same error object (or StrictMode's
  // replayed effect in dev aside) does not file the same report twice.
  React.useEffect(() => {
    reportError(error);
  }, [error]);

  return (
    // A <section>, not <main>: the business and admin shells already wrap
    // their children in a <main>, and a page may only have one.
    <section
      role="alert"
      className={cn(
        "mx-auto flex min-h-[60dvh] max-w-md flex-col items-center justify-center gap-4 px-6 py-12 text-center",
        className,
      )}
    >
      <span className="flex size-16 items-center justify-center rounded-full bg-error-container text-on-error-container">
        <span aria-hidden className="material-symbols-rounded">
          error
        </span>
      </span>

      <h1 className="text-headline-m text-on-surface">Something went wrong on our side</h1>

      <p className="text-body-m text-balance text-on-surface-variant">
        That was not meant to happen, and it is not anything you did. Your points and receipts are
        safe. Try again, or head back and carry on.
      </p>

      <div className="mt-4 flex w-full flex-col gap-3">
        <button type="button" onClick={reset} className={buttonVariants({ size: "touch" })}>
          Try again
        </button>
        <Link href={homeHref} className={buttonVariants({ variant: "outlined", size: "touch" })}>
          {homeLabel}
        </Link>
      </div>

      {error.digest ? (
        <p className="text-label-s text-on-surface-variant">Reference: {error.digest}</p>
      ) : null}
    </section>
  );
}
