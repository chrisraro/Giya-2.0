import * as React from "react";
import { cn } from "@/lib/utils";

export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  helperText?: string;
  errorText?: string;
}

export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(
  ({ id, label, helperText, errorText, className, ...props }, ref) => {
    const hasError = Boolean(errorText);
    const describedBy = hasError ? `${id}-error` : helperText ? `${id}-helper` : undefined;
    return (
      <div className="flex flex-col gap-2">
        <label htmlFor={id} className="text-label-l text-on-surface">
          {label}
        </label>
        <input
          ref={ref}
          id={id}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
          className={cn(
            "h-12 rounded-md3-xs border bg-surface px-4 text-body-l text-on-surface",
            "placeholder:text-on-surface-variant",
            "outline-none transition-colors duration-200 ease-standard",
            hasError
              ? "border-error focus:border-error focus:ring-1 focus:ring-error"
              : "border-outline focus:border-primary focus:ring-1 focus:ring-primary",
            className,
          )}
          {...props}
        />
        {hasError ? (
          <p id={`${id}-error`} role="alert" className="text-body-s text-error">
            {errorText}
          </p>
        ) : helperText ? (
          <p id={`${id}-helper`} className="text-body-s text-on-surface-variant">
            {helperText}
          </p>
        ) : null}
      </div>
    );
  },
);
TextField.displayName = "TextField";
