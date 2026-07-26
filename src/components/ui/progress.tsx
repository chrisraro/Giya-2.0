import { cn } from "@/lib/utils";

// MD3 progress indicators.
//
// MD3 ships two distinct things and this codebase needs both:
//
//   - PROGRESS INDICATOR (this file): linear or circular, determinate or
//     indeterminate. It says "a process is running". Linear when the process
//     belongs to a REGION (a list refreshing, a photo uploading); circular
//     when it belongs to a CONTROL (a button that was tapped).
//   - SKELETON (skeleton.tsx): the shape of content that has not arrived. It
//     says "content is coming, and here is where it will be".
//
// The choice between them is not taste. A skeleton is right when nothing is on
// screen yet, because it reserves the layout. A progress indicator is right when
// something IS on screen and is being replaced or acted on, because replacing
// good content with bones is a downgrade the user did not ask for.
//
// Determinate vs indeterminate is likewise not taste: use determinate ONLY
// when there is a real fraction to show. An invented percentage is a lie, and
// a progress bar that jumps to 90% and sits there is the reason people
// distrust progress bars.
//
// Neither indicator uses tertiary/mango: doc 16 reserves that for rewards
// language, and "something is loading" is not a reward.

export interface LinearProgressProps {
  /**
   * 0-1 when the fraction is genuinely known. Omit for indeterminate, which is
   * the honest default for anything whose duration cannot be measured.
   */
  readonly value?: number | undefined;
  /** Accessible name. Required: an unlabelled progressbar tells AT nothing. */
  readonly label: string;
  readonly className?: string | undefined;
}

/**
 * Linear progress. Full-width by default; pin it to the top edge of the region
 * it describes.
 *
 * Reduced motion: the sweeping animation is defined only inside a
 * `prefers-reduced-motion: no-preference` block in globals.css, so a user who
 * asked for less motion gets a static, full-width track at reduced opacity.
 * That still reads as "busy" and still carries `role="progressbar"` with no
 * `aria-valuenow`, which is the ARIA spelling of indeterminate. Information is
 * preserved; only the flourish is dropped.
 */
export function LinearProgress({ value, label, className }: LinearProgressProps) {
  const determinate = typeof value === "number";
  const clamped = determinate ? Math.min(1, Math.max(0, value)) : 0;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(determinate ? { "aria-valuenow": Math.round(clamped * 100) } : {})}
      className={cn(
        "h-1 w-full overflow-hidden rounded-full bg-secondary-container",
        className,
      )}
    >
      {determinate ? (
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-standard motion-reduce:transition-none"
          style={{ width: `${clamped * 100}%` }}
        />
      ) : (
        // Indeterminate. Without the animation (reduced motion) this is a
        // full-width dimmed bar, which is a legible "busy" state on its own.
        <div className="md3-linear-indeterminate-bar h-full w-full rounded-full bg-primary opacity-70" />
      )}
    </div>
  );
}

const CIRCULAR_SIZE = {
  sm: "size-4 border-2",
  md: "size-6 border-2",
  lg: "size-10 border-[3px]",
} as const;

export interface CircularProgressProps {
  readonly size?: keyof typeof CIRCULAR_SIZE;
  /** Accessible name. Omit only when an ancestor already announces the state. */
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * Circular indeterminate progress, for controls.
 *
 * Built from a bordered box rather than an SVG arc so it inherits `currentColor`
 * and therefore sits correctly on every button variant without a colour prop.
 *
 * Under reduced motion the ring stops spinning and renders as a static
 * three-quarter ring. Paired with the `disabled` + `aria-busy` state that
 * PendingButton applies, the control is still unambiguously "working".
 *
 * When `label` is omitted this is `aria-hidden`, which is the right call
 * inside a button that already announces itself busy: otherwise AT reads the
 * state twice.
 */
export function CircularProgress({ size = "sm", label, className }: CircularProgressProps) {
  return (
    <span
      {...(label ? { role: "progressbar", "aria-label": label } : { "aria-hidden": true })}
      className={cn(
        "md3-spinner inline-block shrink-0 rounded-full border-current border-t-transparent",
        CIRCULAR_SIZE[size],
        className,
      )}
    />
  );
}
