import { LinearProgress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

/**
 * The in-place-refresh member of the loading vocabulary: content is already on
 * screen and is being replaced.
 *
 * A skeleton would be wrong here. Swapping a list the user is reading for a
 * pile of grey bones is a downgrade, and it throws away the thing they came
 * for in order to tell them something they could be told in 4 pixels.
 *
 * The 4px slot is ALWAYS rendered, whether or not it is active. Showing the
 * bar only when busy would push the content below it down by 4px every refresh
 * and pull it back up afterwards, which is exactly the layout shift this pass
 * exists to remove.
 */
export function RefreshIndicator({
  active,
  label,
  className,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly className?: string | undefined;
}) {
  return (
    <div className={cn("h-1 w-full", className)}>
      {active ? (
        <LinearProgress label={label} />
      ) : (
        // Same box, nothing in it. Keeps the reserved height honest.
        <div className="h-1 w-full" />
      )}
    </div>
  );
}
