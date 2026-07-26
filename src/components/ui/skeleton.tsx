import { cn } from "@/lib/utils";

// Skeletons: the route-transition member of the loading vocabulary (doc 16).
//
// The rule this file exists to make easy to follow: a skeleton must occupy the
// SAME space as the content it stands in for. A skeleton that does not match
// its loaded counterpart is worse than no skeleton, because it trades a blank
// screen for a visible layout shift, and cumulative layout shift is a metric
// someone is measuring.
//
// Colour comes from `surface-container-high`, which is a real tonal step above
// `surface` in BOTH themes. A hardcoded light grey is the classic mistake here:
// it vanishes on a dark surface. There are no raw colour values in this file
// and there must never be.

/**
 * One bone. Sized by the caller; everything else in this file is a convenience
 * wrapper around it.
 *
 * `motion-reduce:animate-none` drops the pulse for a consumer who asked their
 * OS for less motion. They still get the correct shape and the correct
 * spacing, which is the part that carries the information.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md3-sm bg-surface-container-high motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Line heights of the MD3 type scale, in Tailwind height classes. A text
 * skeleton has to reserve the LINE box, not the glyph box, or a paragraph of
 * bones comes out shorter than the paragraph of text it replaces.
 *
 * Values mirror the `@utility text-*` definitions in globals.css.
 */
const LINE_BOX = {
  "headline-m": "h-9", // 2.25rem
  "headline-s": "h-8", // 2rem
  "title-l": "h-7", // 1.75rem
  "title-m": "h-6", // 1.5rem
  "title-s": "h-5", // 1.25rem
  "body-l": "h-6", // 1.5rem
  "body-m": "h-5", // 1.25rem
  "body-s": "h-4", // 1rem
  "label-l": "h-5", // 1.25rem
  "label-m": "h-4", // 1rem
  "label-s": "h-4", // 1rem
} as const;

/** The bone inside the line box: shorter than the box, so text bones read as
 *  text rather than as solid blocks. */
const GLYPH_BOX = {
  "headline-m": "h-7",
  "headline-s": "h-6",
  "title-l": "h-5",
  "title-m": "h-4",
  "title-s": "h-3.5",
  "body-l": "h-4",
  "body-m": "h-3.5",
  "body-s": "h-3",
  "label-l": "h-3.5",
  "label-m": "h-3",
  "label-s": "h-3",
} as const;

export type SkeletonTextSize = keyof typeof LINE_BOX;

export interface SkeletonTextProps {
  /** Which type scale step this line stands in for. Drives the reserved height. */
  readonly size?: SkeletonTextSize;
  /** Width of the bone. Defaults to full width; pass e.g. "w-32" or "w-2/3". */
  readonly className?: string | undefined;
}

/**
 * A single line of text-shaped skeleton that reserves exactly the line height
 * of `size`. Use the same size token the real text uses and the two versions
 * of the screen line up.
 */
export function SkeletonText({ size = "body-m", className }: SkeletonTextProps) {
  return (
    <div className={cn("flex items-center", LINE_BOX[size])}>
      <Skeleton className={cn("w-full rounded-md3-xs", GLYPH_BOX[size], className)} />
    </div>
  );
}

/** A circular bone, for avatars and icon plates. `size` is a Tailwind size class. */
export function SkeletonCircle({ className }: { readonly className?: string | undefined }) {
  return <Skeleton className={cn("shrink-0 rounded-full", className)} />;
}

export interface SkeletonScreenProps {
  /**
   * What is loading, as a short noun phrase ("your wallet", "the receipt
   * queue"). Announced politely; never shown.
   */
  readonly label: string;
  readonly className?: string | undefined;
  readonly children: React.ReactNode;
}

/**
 * The root of a `loading.tsx`.
 *
 * Assistive technology gets one polite sentence and nothing else: the bones
 * are `aria-hidden` because a screen reader that walks fifty empty divs is
 * having a worse time than one that hears "Loading your wallet." once.
 * `aria-busy` on the container is what a testing library (and a real AT user)
 * can hang a state check on.
 *
 * The whole screen fades in rather than sliding: a skeleton that slides draws
 * attention to itself, and the point of a skeleton is to be unremarkable.
 */
export function SkeletonScreen({ label, className, children }: SkeletonScreenProps) {
  return (
    <div aria-busy="true" aria-live="polite" className={className}>
      <span className="sr-only">Loading {label}.</span>
      <div aria-hidden className="md3-enter-fade">
        {children}
      </div>
    </div>
  );
}
