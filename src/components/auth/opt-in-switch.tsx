"use client";

import { cn } from "@/lib/utils";

export interface OptInSwitchProps {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}

// Local switch: role="switch" with a 48px hit target (h-12 w-12) wrapping a
// smaller visual track, so the touch target meets spec without an oversized
// track. No Switch primitive exists yet in ui/; promote this if a second
// consumer shows up.
export function OptInSwitch({ id, checked, onChange, label }: OptInSwitchProps) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex size-12 shrink-0 items-center justify-center rounded-full",
        "outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex h-8 w-14 items-center rounded-full border p-1 transition-colors duration-200 ease-standard",
          checked ? "border-primary bg-primary" : "border-outline bg-surface-container-highest",
        )}
      >
        <span
          className={cn(
            "size-6 rounded-full shadow-sm transition-transform duration-200 ease-standard",
            checked ? "translate-x-6 bg-on-primary" : "translate-x-0 bg-outline",
          )}
        />
      </span>
    </button>
  );
}
