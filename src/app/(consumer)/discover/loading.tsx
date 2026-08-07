import * as React from "react";

export default function DiscoverLoading() {
  return (
    <div className="flex flex-col gap-6 animate-pulse px-4 py-6">
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
    </div>
  );
}
