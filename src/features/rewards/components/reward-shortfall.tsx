import { cn } from "@/lib/utils";

export interface RewardShortfallProps {
  /** Points still needed to reach the reward's cost. Always > 0 - callers
   * only render this for an unaffordable reward. */
  readonly shortfall: number;
  readonly className?: string | undefined;
}

/**
 * "1,222 points to go" - doc 03's Key Finding 3 copy, used verbatim instead
 * of a qualitative refusal ("Insufficient balance"): the number is the whole
 * motivation for showing an unaffordable reward at all rather than hiding it.
 *
 * Doc 16's binding a11y rule for this exact string: the LABEL ("points to
 * go") may be `on-surface-variant` (muted, token-sanctioned), but the NUMBER
 * stays full-weight `on-surface` and `font-mono` - the wallet's money/points
 * convention. Muted-gray-on-tinted is the most common contrast failure there
 * is, and this number is the single most important text on the card.
 */
export function RewardShortfall({ shortfall, className }: RewardShortfallProps) {
  return (
    <p className={cn("text-label-s text-on-surface-variant", className)}>
      <span className="font-mono text-on-surface">{shortfall.toLocaleString()}</span> points to go
    </p>
  );
}
