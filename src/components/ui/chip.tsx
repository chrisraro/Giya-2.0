"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  selected?: boolean;
  icon?: React.ReactNode;
}

export function Chip({ label, selected = false, icon, className, ...props }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-full px-4 text-label-l",
        "transition-colors duration-200 ease-standard",
        "outline-none focus-visible:ring-2 focus-visible:ring-primary",
        selected
          ? "bg-secondary-container text-on-secondary-container"
          : "border border-outline bg-transparent text-on-surface-variant hover:bg-surface-container",
        className,
      )}
      {...props}
    >
      {icon}
      {label}
    </button>
  );
}
