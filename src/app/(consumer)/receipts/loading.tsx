import * as React from "react";

export default function ReceiptsLoading() {
  return (
    <div className="flex flex-col gap-6 animate-pulse px-4 py-6">
      <div className="h-7 w-48 rounded bg-surface-container-high" />

      <div className="flex flex-col gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-20 rounded-md3-md border border-outline-variant bg-surface-container-lowest" />
        ))}
      </div>
    </div>
  );
}
