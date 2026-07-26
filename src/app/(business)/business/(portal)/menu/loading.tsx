import { Skeleton, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for menu management.
//
// The layout that matters is the two-pane split: a fixed 240px category rail
// beside a fluid product grid, collapsing to one column below lg. Getting the
// `lg:grid-cols-[240px_1fr]` track right is what stops the product grid from
// jumping left when the categories arrive.

function ProductCardSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3 rounded-md3-md border border-outline-variant p-4">
      <div className="flex items-start justify-between gap-2">
        <SkeletonText size="title-m" className="w-28" />
        <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
      </div>
      <SkeletonText size="title-s" className="w-16" />
      <div className="mt-auto flex flex-col gap-2">
        <Skeleton className="h-10 w-full rounded-full" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-16 rounded-full" />
          <Skeleton className="h-8 w-20 rounded-full" />
        </div>
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <SkeletonScreen label="your menu" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SkeletonText size="headline-s" className="w-48" />
          <SkeletonText size="body-s" className="w-32" />
        </div>
        <Skeleton className="h-10 w-40 shrink-0 rounded-full" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_1fr]">
        {/* Category rail: h-12 rows at gap-2 (the "All items" button) then
            gap-1 rows for each category. */}
        <div className="flex flex-col gap-2">
          <Skeleton className="h-12 w-full rounded-md3-sm" />
          <div className="flex flex-col gap-1">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-1">
                <Skeleton className="h-12 flex-1 rounded-md3-sm" />
              </div>
            ))}
          </div>
        </div>

        {/* Product grid. */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <SkeletonText size="title-l" className="w-32" />
            <Skeleton className="h-10 w-28 shrink-0 rounded-full" />
          </div>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <li key={i}>
                <ProductCardSkeleton />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </SkeletonScreen>
  );
}
