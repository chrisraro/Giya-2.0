import { cn } from "@/lib/utils";

const MARK = (
  <>
    <path d="M52.5 20.5A24 24 0 1 0 56 32v-1.5H38" stroke="currentColor" strokeWidth="9" strokeLinecap="round" fill="none" />
    <path d="M45 15 L31.5 22.5 L28 34 L41.5 26.5 Z" fill="currentColor" />
  </>
);

export function Logo({
  variant = "mark",
  className,
}: {
  variant?: "mark" | "wordmark" | "lockup" | "stamp";
  className?: string;
}) {
  if (variant === "mark") {
    return (
      <svg viewBox="0 0 64 64" className={cn("size-8", className)} aria-label="Giya" role="img">
        {MARK}
      </svg>
    );
  }
  if (variant === "stamp") {
    return (
      <svg viewBox="0 0 72 72" className={cn("size-10", className)} aria-label="Giya stamp" role="img">
        <circle cx="36" cy="36" r="30" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="4 6" />
        <g transform="translate(14 14) scale(0.7)">{MARK}</g>
      </svg>
    );
  }
  // wordmark / lockup
  return (
    <span className={cn("inline-flex items-center gap-2", className)} aria-label="Giya">
      {variant === "lockup" && (
        <svg viewBox="0 0 64 64" className="size-8" aria-hidden>
          {MARK}
        </svg>
      )}
      <span className="text-title-l font-semibold tracking-tight lowercase">giya</span>
    </span>
  );
}
