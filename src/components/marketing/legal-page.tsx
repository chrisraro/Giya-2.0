export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-[70ch] px-4 py-16">
      <h1 className="text-display-s">{title}</h1>
      <div className="mt-4 rounded-md3-md bg-tertiary-container/40 p-4">
        <p className="text-body-m text-on-surface">
          <strong>Draft for review.</strong> This document has not yet been reviewed by counsel. Effective date: to be set at launch.
        </p>
      </div>
      <div className="prose-giya mt-10 space-y-8">{children}</div>
    </main>
  );
}

export function LegalSection({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-headline-s">{heading}</h2>
      <div className="space-y-3 text-body-l leading-relaxed text-on-surface-variant">{children}</div>
    </section>
  );
}
