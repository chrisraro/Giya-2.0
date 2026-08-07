import * as React from "react";

export default function AdminLoading() {
  return (
    <div className="flex flex-col gap-6 animate-pulse p-2">
      {/* Top Banner Skeleton */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2">
          <div className="h-7 w-64 rounded-md bg-surface-container-high" />
          <div className="h-4 w-96 rounded-md bg-surface-container" />
        </div>
        <div className="h-10 w-36 rounded-md3-xs bg-surface-container-high" />
      </div>

      {/* KPI Cards Skeleton */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="flex h-32 flex-col justify-between rounded-md3-md border border-outline-variant bg-surface-container-lowest p-5"
          >
            <div className="flex items-center justify-between">
              <div className="h-4 w-28 rounded bg-surface-container-high" />
              <div className="size-9 rounded-lg bg-surface-container-high" />
            </div>
            <div className="h-8 w-20 rounded bg-surface-container-highest" />
          </div>
        ))}
      </div>

      {/* Quick Access Grid Skeleton */}
      <div className="rounded-md3-md border border-outline-variant bg-surface-container-lowest p-5">
        <div className="mb-4 h-5 w-48 rounded bg-surface-container-high" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-20 rounded-md3-xs border border-outline-variant bg-surface-container" />
          ))}
        </div>
      </div>

      {/* Recent Activity Rows Skeleton */}
      <div className="flex flex-col gap-3">
        <div className="h-6 w-52 rounded bg-surface-container-high" />
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-20 w-full rounded-md3-md border border-outline-variant bg-surface-container-lowest"
          />
        ))}
      </div>
    </div>
  );
}
