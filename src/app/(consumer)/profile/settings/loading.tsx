import { Skeleton, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for /profile/settings.
//
// The page is `force-dynamic` (it reads the caller's own consents), so this is
// seen on every navigation here, not only on a cold one. The shapes match the
// real screen's boxes so nothing shifts when the switches arrive: the back link
// and heading, then three sections of bordered rows - two notification rows, one
// location row, one marketing row - each a two-line description beside a 48px
// switch.

/** One consent row: title, description lines, and the switch's hit target. */
function RowSkeleton({ lines }: { lines: number }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md3-md border border-outline-variant p-4">
      <div className="flex flex-1 flex-col gap-2">
        <SkeletonText size="label-l" className="w-32" />
        {Array.from({ length: lines }, (_, i) => (
          <SkeletonText key={i} size="body-s" className={i === lines - 1 ? "w-2/3" : "w-full"} />
        ))}
      </div>
      <Skeleton className="h-12 w-16 shrink-0 rounded-full" />
    </div>
  );
}

export default function Loading() {
  return (
    <SkeletonScreen label="your preferences" className="mx-auto max-w-md px-4 pt-6 pb-8">
      {/* Back link (h-12), headline, one-line explainer. */}
      <div className="flex h-12 items-center">
        <SkeletonText size="label-l" className="w-20" />
      </div>
      <div className="mt-2 flex flex-col gap-2">
        <SkeletonText size="headline-m" className="w-40" />
        <SkeletonText size="body-m" className="w-full" />
      </div>

      {/* Notifications: heading, explainer, two rows. */}
      <div className="mt-6 flex flex-col gap-3">
        <SkeletonText size="title-m" className="w-32" />
        <SkeletonText size="body-s" className="w-3/4" />
        <RowSkeleton lines={2} />
        <RowSkeleton lines={1} />
      </div>

      {/* Location: heading, one row with the longer explainer. */}
      <div className="mt-8 flex flex-col gap-3">
        <SkeletonText size="title-m" className="w-20" />
        <RowSkeleton lines={3} />
      </div>

      {/* Marketing: its own section, same as the real screen. */}
      <div className="mt-8 flex flex-col gap-3">
        <SkeletonText size="title-m" className="w-24" />
        <RowSkeleton lines={3} />
      </div>
    </SkeletonScreen>
  );
}
