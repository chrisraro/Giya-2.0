import { SkeletonCircle, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for /wallet: balances, then receipts, then the points ledger.
//
// Heights matched to page.tsx: BalanceRow is 56px (p-4 + one 24px line),
// ReceiptHistoryRow and the ledger row are both 64px (py-3 + a 40px icon
// plate).

/** One 64px row with a 40px icon plate, two text lines and a trailing figure.
 *  Shared by the receipts and activity sections because they render the same
 *  row shape in the real page too. */
function LedgerRowSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-md3-md px-2 py-3">
      <SkeletonCircle className="size-10" />
      <div className="min-w-0 flex-1">
        <SkeletonText size="body-l" className="w-40" />
        <SkeletonText size="body-s" className="w-24" />
      </div>
      <SkeletonCircle className="h-6 w-16 rounded-full" />
    </div>
  );
}

export default function Loading() {
  return (
    <SkeletonScreen label="your wallet" className="mx-auto max-w-md px-4 pt-6 pb-8">
      <SkeletonText size="headline-m" className="w-32" />

      {/* Balances: 56px rows at space-y-2. */}
      <section className="mt-6 space-y-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-3 rounded-md3-md border border-outline-variant p-4"
          >
            <div className="min-w-0 flex-1">
              <SkeletonText size="title-m" className="w-36" />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <SkeletonText size="title-m" className="w-12" />
            </div>
          </div>
        ))}
      </section>

      {/* Receipts (WalletReceiptActivity): heading row with a "See all" link,
          then up to three rows at space-y-1. */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-3">
          <SkeletonText size="title-m" className="w-24" />
          <SkeletonText size="label-l" className="w-14" />
        </div>
        <div className="mt-3 space-y-1">
          {[0, 1, 2].map((i) => (
            <LedgerRowSkeleton key={i} />
          ))}
        </div>
      </section>

      {/* Activity ledger. */}
      <section className="mt-8">
        <SkeletonText size="title-m" className="w-20" />
        <div className="mt-3 space-y-1">
          {[0, 1, 2, 3].map((i) => (
            <LedgerRowSkeleton key={i} />
          ))}
        </div>
      </section>
    </SkeletonScreen>
  );
}
