import Link from "next/link";

import { cn } from "@/lib/utils";

export interface NotFoundAction {
  label: string;
  href: string;
  icon: string;
}

export interface NotFoundPanelProps {
  /** The h1. Says what happened in plain words, never "404 Not Found". */
  title: string;
  body: string;
  /** First action renders as the filled primary; the rest render as outlined. */
  actions: readonly NotFoundAction[];
  className?: string;
}

/**
 * The shared body of every 404 screen.
 *
 * WHY THIS EXISTS AS A COMPONENT: there are two `not-found.tsx` boundaries
 * (the root one Next requires for unmatched URLs, and the consumer-group one
 * that keeps the bottom nav) and they differ only in copy and recovery links.
 * The colour decisions are the actual fix and must not be allowed to drift
 * apart between them.
 *
 * EVERY colour here is an MD3 token, never a raw hex. That is the whole point:
 * Next's built-in 404 emits its `<style>` as a React child, so the style never
 * applies and the text inherits whatever the surrounding layout set. Inside the
 * consumer shell that computed to white on the light `bg-surface`, about 1.02:1
 * contrast, which is invisible. `text-on-surface` on `bg-surface` is the token
 * pair MD3 defines as a legible foreground/background match, and it resolves
 * correctly in both the light and dark palettes.
 */
export function NotFoundPanel({ title, body, actions, className }: NotFoundPanelProps) {
  const [primary, ...secondary] = actions;

  return (
    <main
      className={cn(
        "mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 py-12 text-center",
        className,
      )}
    >
      <span className="flex size-16 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container">
        <span aria-hidden className="material-symbols-rounded">
          explore_off
        </span>
      </span>

      <p className="text-label-l text-primary">Error 404</p>

      <h1 className="text-headline-m text-on-surface">{title}</h1>

      <p className="text-body-m text-balance text-on-surface-variant">{body}</p>

      {primary && (
        <div className="mt-4 flex w-full flex-col gap-3">
          <Link
            href={primary.href}
            className={cn(
              "inline-flex h-12 items-center justify-center gap-2 rounded-full",
              "bg-primary px-6 text-label-l text-on-primary",
              "outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
              "motion-safe:transition-opacity motion-safe:duration-200 motion-safe:ease-standard hover:opacity-90",
            )}
          >
            <span aria-hidden className="material-symbols-rounded">
              {primary.icon}
            </span>
            {primary.label}
          </Link>

          {secondary.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className={cn(
                "inline-flex h-12 items-center justify-center gap-2 rounded-full",
                "border border-outline px-6 text-label-l text-on-surface",
                "outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
                "motion-safe:transition-colors motion-safe:duration-200 motion-safe:ease-standard hover:bg-surface-container",
              )}
            >
              <span aria-hidden className="material-symbols-rounded">
                {action.icon}
              </span>
              {action.label}
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
