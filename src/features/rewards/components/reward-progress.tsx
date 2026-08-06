import { LinearProgress } from "@/components/ui/progress";

export interface RewardProgressProps {
  /** The caller's current balance at this business. */
  readonly current: number;
  /** The cheapest reward's cost the caller cannot yet afford - never the
   * catalogue maximum (doc 03, Key Finding 3). */
  readonly target: number;
  readonly rewardName: string;
  readonly className?: string | undefined;
}

/**
 * "850 / 1,500 pts to Free Kape" - the progress rail anchored to the next
 * reachable reward, not the catalogue's most expensive one. McDonald's
 * anchors to the top tier and a 278/6,000-point balance reads as a 4% bar,
 * which got it publicly mocked; anchoring to the NEXT reward instead means
 * the bar is meaningfully full most of the time.
 *
 * Reuses `LinearProgress`: it renders its determinate fill's width straight
 * from the `value` prop at first paint (an inline style, not a class flipped
 * after mount), so the bar never ships empty to a headless render or a
 * hidden tab - doc 16's binding rule for this task.
 *
 * The visible sentence is `aria-hidden`: `LinearProgress`'s own `aria-label`
 * already carries an equivalent ("X of Y points toward Z"), and a
 * screen-reader user hearing both back to back is a duplicate announcement,
 * not two pieces of information.
 */
export function RewardProgress({ current, target, rewardName, className }: RewardProgressProps) {
  const fraction = target > 0 ? Math.min(1, Math.max(0, current / target)) : 0;

  return (
    <div className={className}>
      <p aria-hidden className="text-label-m text-on-surface-variant">
        <span className="font-mono text-on-surface">{current.toLocaleString()}</span>
        {" / "}
        <span className="font-mono text-on-surface">{target.toLocaleString()}</span>
        {` pts to ${rewardName}`}
      </p>
      <LinearProgress
        value={fraction}
        label={`${current.toLocaleString()} of ${target.toLocaleString()} points toward ${rewardName}`}
        className="mt-1"
      />
    </div>
  );
}
