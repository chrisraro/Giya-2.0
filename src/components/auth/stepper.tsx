import { cn } from "@/lib/utils";

export interface StepperProps {
  steps: number;
  activeIndex: number;
  className?: string;
}

export function Stepper({ steps, activeIndex, className }: StepperProps) {
  return (
    <div
      role="group"
      aria-label={`Step ${activeIndex + 1} of ${steps}`}
      className={cn("flex items-center gap-1.5", className)}
    >
      {Array.from({ length: steps }, (_, index) => (
        <span
          key={index}
          data-dot
          aria-hidden
          className={cn(
            "h-2 rounded-full transition-all duration-200 ease-standard",
            index === activeIndex ? "w-6 bg-primary" : "w-2 bg-outline-variant",
          )}
        />
      ))}
    </div>
  );
}
