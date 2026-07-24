"use client";

import * as React from "react";
import { TextField, type TextFieldProps } from "@/components/ui/text-field";
import { cn } from "@/lib/utils";

export type PasswordFieldProps = Omit<TextFieldProps, "type">;

export function PasswordField({ className, ...props }: PasswordFieldProps) {
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="relative">
      <TextField {...props} type={visible ? "text" : "password"} className={cn("pr-12", className)} />
      {/* size-12 = 48px touch target, positioned to exactly overlay the input's
          right edge (top-7 + size-12 = the input's full 48px height) */}
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        className={cn(
          "absolute right-0 top-7 flex size-12 items-center justify-center rounded-r-md3-xs text-on-surface-variant",
          "outline-none transition-colors duration-200 ease-standard",
          "hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
        )}
      >
        <span aria-hidden className="material-symbols-rounded text-[20px]">
          {visible ? "visibility_off" : "visibility"}
        </span>
      </button>
    </div>
  );
}
