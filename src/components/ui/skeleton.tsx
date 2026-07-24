import { cn } from "@/lib/utils";

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
