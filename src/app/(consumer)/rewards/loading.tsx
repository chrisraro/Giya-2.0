import { Skeleton, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for /rewards: the claimable two-column grid, then claims.
//
// The 2-column grid is the distinguishing feature of this page and the thing
// worth getting right. RewardCard is 164px tall (p-4 + title + business +
// badge + a 48px touch-target Claim button); ClaimList cards are 96px.
//
// Mango/tertiary appears on the real cards because points cost is reward
// language. It does NOT appear here: doc 16 reserves tertiary for rewards, and
// a grey bone is not yet a reward. The colour arrives with the content.

export default function Loading() {
  return (
    <SkeletonScreen label="your rewards" className="mx-auto max-w-md px-4 pt-6 pb-8">
      <SkeletonText size="headline-m" className="w-36" />

      <section className="mt-6">
        <SkeletonText size="title-m" className="w-24" />
        <div className="mt-3 grid grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col gap-2 rounded-md3-md bg-surface-container-highest p-4">
              <SkeletonText size="title-s" className="w-full" />
              <SkeletonText size="body-s" className="w-2/3" />
              {/* points-cost badge: 20px pill */}
              <Skeleton className="h-5 w-16 rounded-full" />
              {/* Claim button: h-12 touch target, full width, mt-1 */}
              <Skeleton className="mt-1 h-12 w-full rounded-full" />
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <SkeletonText size="title-m" className="w-20" />
        <div className="mt-3">
          <div className="flex flex-col gap-2">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="flex flex-col gap-2 rounded-md3-md border border-outline-variant p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <SkeletonText size="title-s" className="w-40" />
                    <SkeletonText size="body-s" className="w-28" />
                  </div>
                  <Skeleton className="h-5 w-20 shrink-0 rounded-full" />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </SkeletonScreen>
  );
}
