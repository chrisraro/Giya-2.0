import * as React from "react";

export default function HomeLoading() {
  return (
    <div className="flex flex-col gap-6 animate-pulse px-4 py-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="size-12 rounded-full bg-surface-container-high" />
          <div className="flex flex-col gap-1.5">
            <div className="h-4 w-32 rounded bg-surface-container-high" />
            <div className="h-3 w-20 rounded bg-surface-container" />
          </div>
        </div>
        <div className="size-10 rounded-full bg-surface-container-high" />
      </div>

      <div className="h-36 w-full rounded-md3-lg bg-surface-container-high" />

      <div className="flex flex-col gap-3">
        <div className="h-5 w-40 rounded bg-surface-container-high" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-44 rounded-md3-md bg-surface-container-lowest border border-outline-variant" />
          ))}
        </div>
      </div>
    </div>
  );
}
