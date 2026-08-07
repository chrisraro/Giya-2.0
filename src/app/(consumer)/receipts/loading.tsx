import * as React from "react";

export default function ReceiptsLoading() {
  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-8 animate-pulse flex flex-col gap-6">
      <div className="h-7 w-48 rounded bg-surface-container-high" />

      {/* 5 filter chips inside overflow-hidden */}
      <div className="flex items-center gap-2 overflow-hidden">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-8 w-20 shrink-0 rounded-full bg-surface-container-high" />
        ))}
      </div>

      <div className="flex flex-col gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-20 rounded-md3-md border border-outline-variant bg-surface-container-lowest" />
        ))}
      </div>
    </main>
  );
}
