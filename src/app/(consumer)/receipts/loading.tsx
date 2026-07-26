import { Skeleton, SkeletonCircle, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for /receipts.
//
// The filter chip row is worth rendering as five real 32px pills rather than
// one long bone: the chips are the page's navigation, they are always exactly
// five, and their widths are known from the labels ("All", "Processing",
// "In review", "Approved", "Not accepted"). Getting them right means the row
// does not reflow when the real chips land.

/** Widths approximating the five fixed filter labels at text-label-l. */
const CHIP_WIDTHS = ["w-12", "w-24", "w-24", "w-24", "w-28"] as const;

export default function Loading() {
  return (
    <SkeletonScreen label="your receipts" className="mx-auto max-w-md px-4 pt-6 pb-8">
      <SkeletonText size="headline-m" className="w-36" />
      <div className="mt-1">
        <SkeletonText size="body-m" className="w-full" />
      </div>

      <section className="mt-6">
        {/* Status filter chips: h-8 pills, pb-1, horizontally scrolling. */}
        <div className="-mx-4 flex gap-2 overflow-hidden px-4 pb-1">
          {CHIP_WIDTHS.map((width, i) => (
            <Skeleton key={i} className={`h-8 shrink-0 rounded-full ${width}`} />
          ))}
        </div>

        {/* Receipt rows: 64px each at space-y-1. */}
        <div className="mt-4 space-y-1">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-3 rounded-md3-md px-2 py-3">
              <SkeletonCircle className="size-10" />
              <div className="min-w-0 flex-1">
                <SkeletonText size="body-l" className="w-44" />
                <SkeletonText size="body-s" className="w-28" />
              </div>
              <Skeleton className="h-5 w-14 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      </section>
    </SkeletonScreen>
  );
}
