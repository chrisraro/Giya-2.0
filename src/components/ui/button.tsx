import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  [
    // base + MD3 state layer via ::after (hover 8%, pressed 10%)
    "relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-full",
    "text-label-l whitespace-nowrap select-none",
    "transition-all duration-200 ease-standard",
    "outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
    "disabled:pointer-events-none disabled:opacity-40",
    "active:scale-[0.98]",
    "after:absolute after:inset-0 after:rounded-full after:bg-current after:opacity-0 after:transition-opacity",
    "hover:after:opacity-[0.08] active:after:opacity-[0.10]",
  ],
  {
    variants: {
      variant: {
        filled: "bg-primary text-on-primary",
        tonal: "bg-secondary-container text-on-secondary-container",
        outlined: "border border-outline bg-transparent text-primary",
        text: "bg-transparent px-3 text-primary",
        elevated: "bg-surface-container-low text-primary shadow-md",
      },
      size: {
        sm: "h-8 px-4",
        md: "h-10 px-6",
        touch: "h-12 px-6", // consumer surfaces: 48px minimum
      },
    },
    defaultVariants: { variant: "filled", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";

export { Button, buttonVariants };
