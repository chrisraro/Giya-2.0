import { cn } from "@/lib/utils";

// List and section entrance motion.
//
// Deliberately NOT a Motion-library component. Every list in this app that
// wants an entrance is server-rendered, and these classes animate on first
// paint with zero client JavaScript. The Motion library is reserved for the
// one surface that needs real physics (the approved-receipt celebration).
//
// The reduced-motion contract lives in globals.css: the keyframes and the
// `.md3-enter*` / `.md3-stagger-item` rules exist ONLY inside a
// `prefers-reduced-motion: no-preference` media query. So these components
// render the same DOM either way, and a user who asked for less motion simply
// gets the settled state. There is no way to accidentally ship required motion
// through this file.

/**
 * How many items get a staggered delay before the rest come in together.
 *
 * A stagger is a nice touch on the rows someone is actually looking at and an
 * irritation on row 40, which would otherwise wait 1.6 seconds to appear. Six
 * covers roughly one mobile viewport of list rows.
 */
export const STAGGER_CAP = 6;

export interface StaggerItemProps {
  /** Position in the list. Delay is `min(index, STAGGER_CAP) * 40ms`. */
  readonly index: number;
  readonly className?: string | undefined;
  readonly children: React.ReactNode;
}

/**
 * One list item entering with the MD3 emphasized-decelerate curve, delayed by
 * its position.
 */
export function StaggerItem({ index, className, children }: StaggerItemProps) {
  return (
    <div
      className={cn("md3-stagger-item", className)}
      style={{ "--md3-stagger-index": Math.min(index, STAGGER_CAP) } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

/**
 * A block entering as a unit: a page section, a card, a KPI row. Slides up 12px
 * on the entering curve.
 */
export function Enter({
  className,
  children,
}: {
  readonly className?: string | undefined;
  readonly children: React.ReactNode;
}) {
  return <div className={cn("md3-enter", className)}>{children}</div>;
}
