import { Skeleton, SkeletonCircle, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for /scan.
//
// /scan renders two entirely different screens: the shop chooser (no
// `?business=`) and the camera capture (with one). The chooser is the shape to
// match, because it is what the bottom-nav Scan FAB opens and therefore the
// overwhelmingly common arrival. Someone reaching the capture screen came from
// a business page, already knows where they are going, and the capture screen
// is a client component that paints its own idle state immediately anyway.

export default function Loading() {
  return (
    <SkeletonScreen
      label="shops you can scan a receipt from"
      className="mx-auto flex max-w-md flex-col gap-4 px-4 pt-6 pb-8"
    >
      <div>
        <SkeletonText size="headline-m" className="w-full" />
      </div>

      <div className="flex flex-col gap-5">
        {/* Intro paragraph: three lines at text-body-m. */}
        <div>
          <SkeletonText size="body-m" className="w-full" />
          <SkeletonText size="body-m" className="w-full" />
          <SkeletonText size="body-m" className="w-2/3" />
        </div>

        {/* Store list: 68px rows (p-3 + a 44px avatar) at space-y-2. */}
        <section>
          <SkeletonText size="title-m" className="w-36" />
          <div className="mt-3 space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-md3-md border border-outline-variant p-3"
              >
                <SkeletonCircle className="size-11" />
                <div className="min-w-0 flex-1">
                  <SkeletonText size="title-m" className="w-40" />
                  <div className="mt-0.5">
                    <SkeletonText size="body-s" className="w-24" />
                  </div>
                </div>
                <Skeleton className="size-6 shrink-0 rounded-full" />
              </div>
            ))}
          </div>
        </section>
      </div>
    </SkeletonScreen>
  );
}
