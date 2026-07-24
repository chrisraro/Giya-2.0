import * as React from "react";
import { cn } from "@/lib/utils";

/** Reward-language badge: tertiary (Mango) tokens are reserved for points/rewards. */
export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-tertiary-container px-2.5 py-0.5 font-mono text-label-m text-on-tertiary-container",
        className,
      )}
      {...props}
    />
  );
}
