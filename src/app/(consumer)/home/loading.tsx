import { Skeleton, SkeletonCircle, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for /home. Mirrors page.tsx: greeting header, points card,
// loyalty strip, then the "Shops on Giya" list.
//
// The populated shape is the one worth matching. A returning consumer with
// balances is the common case, and the empty-state variant of this page is
// shorter, so matching the populated layout means content never has to push
// downward when it arrives.
//
// Note what is NOT here: the bottom nav. It lives in (consumer)/layout.tsx,
// outside this loading boundary, so it stays on screen throughout the
// navigation. That persistence is most of why a route skeleton feels fast.

export default function Loading() {
  return (
    <SkeletonScreen label="your home" className="mx-auto max-w-md px-4 pt-6">
      {/* Header: greeting + date on the left, bell (40px) + logo (32px) right.
          The 40px bell sets the header height, same as the real page. */}
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <SkeletonText size="headline-s" className="w-44" />
          <div className="mt-0.5">
            <SkeletonText size="body-s" className="w-28" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <SkeletonCircle className="size-10" />
          <SkeletonCircle className="size-8" />
        </div>
      </header>

      {/* Points card. 20 + 40 padding + 4 + 36 + 4 + 16 = 120px. Rendered as a
          single neutral bone rather than a tinted card: primary-container is a
          strong colour and a skeleton that arrives fully branded then swaps its
          text in reads as broken rather than as loading. */}
      <Skeleton className="mt-6 h-[120px] w-full rounded-md3-md" />

      {/* Loyalty strip: 240x138 cards scrolling horizontally. Two are enough to
          establish the shape and imply the third is off-screen. */}
      <section className="mt-8">
        <div className="-mx-4 flex gap-3 overflow-hidden px-4 pb-1">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-[138px] w-[240px] shrink-0 rounded-md3-md" />
          ))}
        </div>
      </section>

      {/* Shops on Giya: title + three 76px BusinessCard rows at space-y-3. */}
      <section className="mt-8 pb-8">
        <SkeletonText size="title-m" className="w-32" />
        <div className="mt-3 space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-md3-md border border-outline-variant p-4"
            >
              <SkeletonCircle className="size-11" />
              <div className="min-w-0 flex-1">
                <SkeletonText size="title-m" className="w-40" />
                <div className="mt-0.5">
                  <SkeletonText size="body-s" className="w-24" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </SkeletonScreen>
  );
}
