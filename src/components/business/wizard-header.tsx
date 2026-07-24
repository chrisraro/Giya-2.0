import { cn } from "@/lib/utils";

export interface WizardHeaderProps {
  steps: string[];
  activeIndex: number;
  className?: string;
}

// Numbered progress header for business surfaces. Teal (secondary) leads:
// active/complete numbers sit on `bg-secondary-container`, active label is
// `text-secondary`, connector lines fill `bg-secondary` once passed.
export function WizardHeader({ steps, activeIndex, className }: WizardHeaderProps) {
  return (
    <div
      role="group"
      aria-label={`Step ${activeIndex + 1} of ${steps.length}`}
      className={cn("flex items-start", className)}
    >
      {steps.map((label, index) => {
        const isActive = index === activeIndex;
        const isComplete = index < activeIndex;
        const isLast = index === steps.length - 1;
        return (
          <div key={label} className={cn("flex items-center", !isLast && "flex-1")}>
            <div className="flex flex-col items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full text-label-l transition-colors duration-200 ease-standard",
                  isActive || isComplete
                    ? "bg-secondary-container text-on-secondary-container"
                    : "border border-outline-variant text-on-surface-variant",
                )}
              >
                {isComplete ? (
                  <span className="material-symbols-rounded is-filled text-[18px]">check</span>
                ) : (
                  index + 1
                )}
              </span>
              <span
                className={cn(
                  "text-label-m whitespace-nowrap",
                  isActive ? "text-secondary" : "text-on-surface-variant",
                )}
              >
                {label}
              </span>
            </div>
            {!isLast ? (
              <span
                aria-hidden
                className={cn(
                  "mx-2 mt-4 h-px flex-1",
                  isComplete ? "bg-secondary" : "bg-outline-variant",
                )}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
