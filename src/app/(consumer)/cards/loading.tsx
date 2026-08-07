import * as React from "react";

export default function CardsLoading() {
  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-8 animate-pulse flex flex-col gap-6">
      <div className="h-7 w-48 rounded bg-surface-container-high" />

      <div className="grid gap-4 sm:grid-cols-2">
        {[1, 2].map((i) => (
          <div key={i} className="h-48 rounded-md3-lg border border-outline-variant bg-surface-container-lowest" />
        ))}
      </div>
    </main>
  );
}
