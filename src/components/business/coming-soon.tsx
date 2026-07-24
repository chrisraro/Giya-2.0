import Link from "next/link";

export interface ComingSoonProps {
  title: string;
}

/** Centered placeholder panel for portal sections that have not shipped yet. */
export function ComingSoon({ title }: ComingSoonProps) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container">
        <span aria-hidden className="material-symbols-rounded text-[28px]">
          construction
        </span>
      </span>
      <div className="space-y-1">
        <h1 className="text-headline-s text-on-surface">{title}</h1>
        <p className="text-body-m text-on-surface-variant">
          This area arrives with the next milestone.
        </p>
      </div>
      <Link
        href="/business/dashboard"
        className="mt-2 inline-flex h-10 items-center rounded-full bg-secondary-container px-5 text-label-l text-on-secondary-container transition-colors duration-200 ease-standard hover:opacity-90"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
