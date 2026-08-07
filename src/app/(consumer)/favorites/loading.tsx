import * as React from "react";

export default function FavoritesLoading() {
  return (
    <div className="flex flex-col gap-6 animate-pulse px-4 py-6">
      <div className="h-7 w-44 rounded bg-surface-container-high" />

      <div className="grid gap-4 sm:grid-cols-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-28 rounded-md3-md border border-outline-variant bg-surface-container-lowest" />
        ))}
      </div>
    </div>
  );
}
