import * as React from "react";

export default function DiscoverLoading() {
  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-8 animate-pulse flex flex-col gap-6">
      <div className="h-12 w-full rounded-md3-xs bg-surface-container-high" />

      <div className="flex items-center gap-2 overflow-hidden">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-8 w-24 shrink-0 rounded-full bg-surface-container-high" />
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-32 rounded-md3-md border border-outline-variant bg-surface-container-lowest" />
        ))}
      </div>
    </main>
  );
}
