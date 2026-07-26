import { Skeleton, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for one receipt in the review queue.
//
// The decision screen is the highest-stakes screen in the portal: a person is
// about to approve or reject money. It is also the slowest to load, because it
// reads the receipt, the fraud signals and the submitter's history. That
// combination is exactly when a blank screen is most damaging, and exactly why
// this file matters more than its line count suggests.
//
// Layout: header, then a two-column split (photo | six extracted fields), then
// fraud signals, then a four-tile history strip.

/** One editable field: 20px label row + 8px gap + a 44px input. */
function FieldSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SkeletonText size="label-l" className="w-24" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <Skeleton className="h-11 w-full rounded-md3-xs" />
    </div>
  );
}

export default function Loading() {
  return (
    <SkeletonScreen label="this receipt" className="flex flex-col gap-6">
      {/* Header: back link, title + status chip, subtitle. */}
      <div className="flex flex-col gap-2">
        <SkeletonText size="label-l" className="w-28" />
        <div className="flex flex-wrap items-center gap-3">
          <SkeletonText size="headline-s" className="w-52" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
        <SkeletonText size="body-s" className="w-64" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* The photo. Its real height is intrinsic to the image, so the
            skeleton reserves the same min-h-64 the no-image fallback uses.
            An aspect-ratio guess would be worse: receipts are long and thin,
            and guessing wrong shifts the whole right column. */}
        <section className="flex flex-col gap-2">
          <SkeletonText size="title-m" className="w-24" />
          <Skeleton className="min-h-64 w-full rounded-md3-md" />
          <SkeletonText size="body-s" className="w-40" />
        </section>

        {/* Extracted fields: three full width, then three across at sm. */}
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <SkeletonText size="title-m" className="w-36" />
            <SkeletonText size="body-s" className="w-16" />
          </div>

          <FieldSkeleton />
          <FieldSkeleton />
          <FieldSkeleton />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FieldSkeleton />
            <FieldSkeleton />
            <FieldSkeleton />
          </div>

          {/* Line items. */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <SkeletonText size="label-l" className="w-24" />
              <Skeleton className="h-8 w-24 rounded-full" />
            </div>
            <div className="flex flex-col gap-2">
              {[0, 1].map((i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <Skeleton className="h-11 min-w-40 flex-1 rounded-md3-xs" />
                  <Skeleton className="h-11 w-20 rounded-md3-xs" />
                  <Skeleton className="h-11 w-28 rounded-md3-xs" />
                </div>
              ))}
            </div>
          </div>

          {/* Approve / reject. */}
          <div className="flex flex-wrap gap-3">
            <Skeleton className="h-10 w-32 rounded-full" />
            <Skeleton className="h-10 w-28 rounded-full" />
          </div>
        </section>
      </div>

      {/* Fraud signals. */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <SkeletonText size="title-m" className="w-32" />
          <SkeletonText size="body-s" className="w-12" />
        </div>
        <Skeleton className="h-14 w-full rounded-md3-md" />
      </section>

      {/* Submitter history: four 68px tiles. */}
      <section className="flex flex-col gap-2">
        <SkeletonText size="title-m" className="w-40" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="rounded-md3-md border border-outline-variant p-3">
              <SkeletonText size="body-s" className="w-20" />
              <SkeletonText size="title-l" className="w-10" />
            </div>
          ))}
        </div>
        <SkeletonText size="body-s" className="w-56" />
      </section>
    </SkeletonScreen>
  );
}
