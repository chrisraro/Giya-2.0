import { Skeleton, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for /b/[slug], the public shop page.
//
// This page declares `revalidate = 60`, but is not actually served from an
// ISR cache: every read goes through `createClient()`, which calls
// `cookies()` (task 5 added a second one, the viewer's own session for the
// balance lookup) - a dynamic API that forces per-request rendering
// regardless of the export. So this skeleton is seen on every navigation
// here, not just a cold slug, and it is also the page an unauthenticated
// visitor is most likely to land on first, which makes it the app's first
// impression either way.
//
// The signature detail is the avatar overlapping the cover image: an 80px
// circle pulled up 40px with a 4px surface ring. Reproducing that overlap is
// what makes this read as "the shop page, loading" rather than "some page".

export default function Loading() {
  return (
    <SkeletonScreen label="this shop" className="mx-auto max-w-md pb-32">
      {/* Cover: h-40 mobile, h-48 from sm. */}
      <Skeleton className="h-40 w-full rounded-none sm:h-48" />

      <div className="px-4">
        {/* Avatar, overlapping the cover by 40px. The ring keeps the ring-surface
            gap the real avatar has, so nothing shifts sideways either. */}
        <div className="relative z-10 -mt-10 flex items-end gap-3">
          <Skeleton className="size-20 shrink-0 rounded-full ring-4 ring-surface" />
        </div>

        <div className="mt-3">
          <SkeletonText size="headline-s" className="w-52" />
        </div>
        <div className="mt-0.5">
          <SkeletonText size="body-s" className="w-32" />
        </div>
        <div className="mt-2">
          <SkeletonText size="body-m" className="w-full" />
          <SkeletonText size="body-m" className="w-3/4" />
        </div>
        <div className="mt-2">
          <SkeletonText size="label-l" className="w-40" />
        </div>
      </div>

      {/* Rewards: an optional progress rail (label + 4px bar, shown for a
          signed-in viewer who already has a balance here - task 5), then
          56px list items at gap-3. */}
      <div className="mt-6 px-4">
        <SkeletonText size="title-l" className="w-28" />
        <div className="mt-2 flex flex-col gap-1">
          <SkeletonText size="label-m" className="w-48" />
          <Skeleton className="h-1 w-full rounded-full" />
        </div>
        <div className="mt-3 flex flex-col gap-3">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-md3-md border border-outline-variant p-4">
              <div className="flex items-start justify-between gap-3">
                <SkeletonText size="title-m" className="w-40" />
                <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Menu: one group heading plus product rows at gap-3. */}
      <div className="mt-6 px-4">
        <div className="flex flex-col gap-8">
          <section>
            <SkeletonText size="title-l" className="w-32" />
            <div className="mt-3 flex flex-col gap-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex items-start justify-between gap-3 rounded-md3-md border border-outline-variant p-4"
                >
                  <div className="min-w-0 flex-1">
                    <SkeletonText size="title-m" className="w-36" />
                    <div className="mt-1">
                      <SkeletonText size="body-s" className="w-48" />
                    </div>
                  </div>
                  <SkeletonText size="title-s" className="w-14" />
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </SkeletonScreen>
  );
}
