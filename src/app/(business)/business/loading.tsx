import * as React from "react";

export default function BusinessLoading() {
  return (
    <div className="flex flex-col gap-6 animate-pulse p-4">
      <div className="flex items-center justify-between">
        <div className="h-8 w-48 rounded-md bg-surface-container-high" />
        <div className="h-10 w-32 rounded-md3-xs bg-surface-container-high" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-28 rounded-md3-md border border-outline-variant bg-surface-container-lowest p-4"
          />
        ))}
      </div>

      <div className="h-64 w-full rounded-md3-md border border-outline-variant bg-surface-container-lowest" />
    </div>
  );
}
