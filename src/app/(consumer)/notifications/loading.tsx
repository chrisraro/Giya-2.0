import { Skeleton, SkeletonCircle, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for /notifications.
//
// Rows are three-line (title, two-line clamped body, timestamp) beside a 40px
// icon plate, giving ~98px per row at `items-start`. Grouped under a day
// heading, exactly as NotificationList groups them.
//
// The header's "Mark all read" button only renders when something is unread,
// but it is h-9 against an h-9 heading line box, so the header is the same
// height either way and a bone for it costs nothing in shift either way.

function NotificationRowSkeleton() {
  return (
    <div className="flex w-full items-start gap-3 rounded-md3-md px-2 py-3">
      <SkeletonCircle className="size-10" />
      <div className="min-w-0 flex-1">
        <SkeletonText size="body-l" className="w-44" />
        <SkeletonText size="body-s" className="w-full" />
        <SkeletonText size="body-s" className="w-3/4" />
        <div className="mt-0.5">
          <SkeletonText size="label-s" className="w-16" />
        </div>
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <SkeletonScreen label="your notifications" className="mx-auto max-w-md px-4 pt-6 pb-8">
      <header className="flex items-center justify-between gap-3">
        <SkeletonText size="headline-m" className="w-48" />
        <Skeleton className="h-9 w-28 shrink-0 rounded-full" />
      </header>

      <div className="mt-4 space-y-6">
        {["today", "earlier"].map((group, groupIndex) => (
          <section key={group}>
            <div className="px-2">
              <SkeletonText size="label-l" className="w-20" />
            </div>
            <div className="mt-1 space-y-1">
              {(groupIndex === 0 ? [0, 1, 2] : [0, 1]).map((i) => (
                <NotificationRowSkeleton key={i} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </SkeletonScreen>
  );
}
