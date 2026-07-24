import Link from "next/link";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon: string;
  title: string;
  body: string;
  action?: { label: string; href: string };
  className?: string;
}

/** Designed empty state: tonal icon circle, title, body, optional Link CTA. */
export function EmptyState({ icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center gap-3 rounded-md3-md px-6 py-10 text-center", className)}>
      <span className="flex size-12 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container">
        <span aria-hidden className="material-symbols-rounded">
          {icon}
        </span>
      </span>
      <div className="space-y-1">
        <p className="text-title-m text-on-surface">{title}</p>
        <p className="text-body-m text-on-surface-variant">{body}</p>
      </div>
      {action && (
        <Link
          href={action.href}
          className="mt-2 inline-flex h-10 items-center rounded-full bg-secondary-container px-5 text-label-l text-on-secondary-container transition-colors duration-200 ease-standard hover:opacity-90"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}
