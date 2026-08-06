import { Skeleton, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for /profile/edit.
//
// The page is `force-dynamic` (it reads the caller's own profile), so this is
// seen on every navigation here, not only on a cold one. The shapes below match
// the real screen's boxes so nothing shifts when the form arrives: the back link
// and heading, an 80px avatar circle beside its two buttons, a 48px text field
// under its label, and the city picker's 48px search field above its
// `max-h-64` list of 52px rows.

export default function Loading() {
  return (
    <SkeletonScreen label="your profile" className="mx-auto max-w-md px-4 pt-6 pb-8">
      {/* Back link (h-12) then the headline. */}
      <div className="flex h-12 items-center">
        <SkeletonText size="label-l" className="w-20" />
      </div>
      <div className="mt-2">
        <SkeletonText size="headline-m" className="w-44" />
      </div>

      {/* Photo: the 80px circle and the two pill controls beside it. */}
      <div className="mt-6 flex flex-col gap-4">
        <SkeletonText size="title-m" className="w-16" />
        <div className="flex items-center gap-4">
          <Skeleton className="size-20 shrink-0 rounded-full" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-10 w-32 rounded-full" />
            <Skeleton className="h-10 w-28 rounded-full" />
          </div>
        </div>
      </div>

      {/* Name: label, 48px field, helper line. */}
      <div className="mt-8 flex flex-col gap-4">
        <SkeletonText size="title-m" className="w-14" />
        <div className="flex flex-col gap-2">
          <SkeletonText size="label-l" className="w-28" />
          <Skeleton className="h-12 w-full rounded-md3-xs" />
          <SkeletonText size="body-s" className="w-56" />
        </div>
      </div>

      {/* City: heading, one-line explainer, the picker's search field, then the
          scrolling list of rows. */}
      <div className="mt-8 flex flex-col gap-4">
        <SkeletonText size="title-m" className="w-10" />
        <SkeletonText size="body-s" className="w-48" />
        <div className="flex flex-col gap-2">
          <SkeletonText size="label-l" className="w-24" />
          <Skeleton className="h-12 w-full rounded-md3-xs" />
        </div>
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-13 w-full rounded-md3-md" />
          ))}
        </div>
      </div>

      {/* Save (size="touch" is 56px). */}
      <div className="mt-8">
        <Skeleton className="h-14 w-full rounded-full" />
      </div>
    </SkeletonScreen>
  );
}
