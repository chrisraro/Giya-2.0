import { Skeleton, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for business settings.
//
// A long form, and the page where a mismatched skeleton would be most obvious:
// the four section cards have very different heights, and the opening-hours
// card is roughly half the page on its own. The counts here are exact, not
// representative -- 1 + 1 text areas, 6 contact fields, 3 location fields, 7
// day rows -- because they are fixed by the form, not by data.

/** Label (20px) + gap (8px) + input (48px) = 76px, the TextField block. */
function FieldSkeleton({ className }: { readonly className?: string }) {
  return (
    <div className={className}>
      <div className="flex flex-col gap-2">
        <SkeletonText size="label-l" className="w-24" />
        <Skeleton className="h-12 w-full rounded-md3-xs" />
      </div>
    </div>
  );
}

function SectionSkeleton({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-md3-md border border-outline-variant p-4 sm:p-6">
      {children}
    </div>
  );
}

export default function Loading() {
  return (
    <SkeletonScreen label="your settings" className="flex flex-col gap-6">
      <div>
        <SkeletonText size="headline-s" className="w-32" />
        <SkeletonText size="body-s" className="w-72" />
      </div>

      {/* Verification status card. */}
      <div className="flex flex-col gap-1 rounded-md3-md bg-surface-container-highest p-4">
        <SkeletonText size="title-s" className="w-40" />
        <SkeletonText size="body-s" className="w-56" />
        <SkeletonText size="body-s" className="w-full" />
      </div>

      {/* Your business: name + description textarea. */}
      <SectionSkeleton>
        <SkeletonText size="title-m" className="w-36" />
        <FieldSkeleton />
        <div className="flex flex-col gap-2">
          <SkeletonText size="label-l" className="w-28" />
          {/* rows={3} textarea: 3 * 24px line + 24px padding. */}
          <Skeleton className="h-[96px] w-full rounded-md3-xs" />
        </div>
      </SectionSkeleton>

      {/* How customers reach you: phone/email, website, three socials. */}
      <SectionSkeleton>
        <SkeletonText size="title-m" className="w-56" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FieldSkeleton />
          <FieldSkeleton />
        </div>
        <FieldSkeleton />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FieldSkeleton />
          <FieldSkeleton />
          <FieldSkeleton />
        </div>
      </SectionSkeleton>

      {/* Where you are. */}
      <SectionSkeleton>
        <SkeletonText size="title-m" className="w-32" />
        <FieldSkeleton />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FieldSkeleton />
          <FieldSkeleton />
        </div>
        <SkeletonText size="body-s" className="w-64" />
      </SectionSkeleton>

      {/* Opening hours: exactly seven day rows. */}
      <SectionSkeleton>
        <SkeletonText size="title-m" className="w-36" />
        <SkeletonText size="body-s" className="w-full" />
        <div className="flex flex-col gap-3">
          {[0, 1, 2, 3, 4, 5, 6].map((day) => (
            <div
              key={day}
              className="flex flex-wrap items-center gap-3 border-b border-outline-variant pb-3 last:border-b-0 last:pb-0"
            >
              <SkeletonText size="body-m" className="w-24" />
              <Skeleton className="h-5 w-20 rounded-md3-xs" />
              <Skeleton className="h-10 w-28 rounded-md3-xs" />
              <SkeletonText size="body-s" className="w-4" />
              <Skeleton className="h-10 w-28 rounded-md3-xs" />
            </div>
          ))}
        </div>
        <Skeleton className="h-8 w-36 rounded-full" />
      </SectionSkeleton>

      <div className="flex justify-end">
        <Skeleton className="h-12 w-36 rounded-full" />
      </div>
    </SkeletonScreen>
  );
}
