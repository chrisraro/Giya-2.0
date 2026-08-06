import { Skeleton, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for /rewards: business groups (each a heading, an optional
// progress rail, then a two-column grid), then claims.
//
// Task 5 restructured the "Available" section from one flat grid into one
// block per business (heading + optional RewardProgress rail above its own
// grid, `gap-6` between groups) - this skeleton reserves that shape now, not
// the old flat grid, per doc 16's "a skeleton must occupy the same space as
// its loaded counterpart" rule. Two group blocks is a representative count
// (mirrors /wallet's loading.tsx picking two balance rows), not a real
// business count, which cannot be known before the data arrives.
//
// RewardCard is 164px tall (p-4 + title + business + badge + a 48px
// touch-target Claim button); ClaimList cards are 96px.
//
// Mango/tertiary appears on the real cards because points cost is reward
// language. It does NOT appear here: doc 16 reserves tertiary for rewards, and
// a grey bone is not yet a reward. The colour arrives with the content.

/** One business group: title-s heading, a label + 4px bar for the optional
 * progress rail, then its own two-column card grid. Matches page.tsx's
 * per-group markup. */
function RewardGroupSkeleton() {
  return (
    <div>
      <SkeletonText size="title-s" className="w-32" />
      <div className="mt-2 flex flex-col gap-1">
        <SkeletonText size="label-m" className="w-40" />
        <Skeleton className="h-1 w-full rounded-full" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {[0, 1].map((i) => (
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
    </div>
  );
}

export default function Loading() {
  return (
    <SkeletonScreen label="your rewards" className="mx-auto max-w-md px-4 pt-6 pb-8">
      <SkeletonText size="headline-m" className="w-36" />

      <section className="mt-6">
        <SkeletonText size="title-m" className="w-24" />
        <div className="mt-3 flex flex-col gap-6">
          {[0, 1].map((i) => (
            <RewardGroupSkeleton key={i} />
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
