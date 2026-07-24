import { cn } from "@/lib/utils";

export interface AuthCardProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

// Styled to match Card's "outlined" variant (border-outline-variant, bg-surface)
// but with the larger rounded-md3-xl sheet radius auth surfaces need. Built as a
// plain element rather than <Card variant="outlined" className="rounded-md3-xl">
// because Card's cva base always applies rounded-md3-md, and tailwind-merge does
// not treat custom md3-* radius utilities as a single conflicting group, so an
// override className is not guaranteed to win the cascade.
export function AuthCard({ title, subtitle, children, footer, className }: AuthCardProps) {
  return (
    <div
      className={cn(
        "w-full max-w-md rounded-md3-xl border border-outline-variant bg-surface p-6 text-on-surface sm:p-8",
        className,
      )}
    >
      <div className="flex flex-col gap-1 text-center">
        <h1 className="text-headline-s">{title}</h1>
        {subtitle ? <p className="text-body-m text-on-surface-variant">{subtitle}</p> : null}
      </div>
      <div className="mt-6 flex flex-col gap-4">{children}</div>
      {footer ? (
        <div className="mt-6 flex flex-col items-center gap-3 text-center">{footer}</div>
      ) : null}
    </div>
  );
}
