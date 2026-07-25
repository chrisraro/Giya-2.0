import { NotFoundPanel } from "@/components/shell/not-found-panel";

// The CONSUMER 404 boundary.
//
// `notFound()` is caught by the nearest `not-found.tsx` up the segment tree,
// and route groups are segments, so this file catches every `notFound()` call
// inside `(consumer)`. There are four of them today, two shipped by the
// receipts slice:
//
//   * `(consumer)/receipts`             - signed out
//   * `(consumer)/scan/[receiptId]`     - signed out, or the receipt is not
//                                         yours (deliberately indistinguishable
//                                         from "does not exist", per doc 13)
//   * `(consumer)/b/[slug]`             - no such business
//   * `(consumer)/rewards/claims/[claimId]` - not yours or does not exist
//
// Because it lives inside the group, it renders within
// `(consumer)/layout.tsx`: the consumer `bg-surface` shell with the bottom nav
// still mounted, so a consumer who lands here is one tap from anywhere rather
// than stranded on a bare page. That is the reason this exists separately from
// the root boundary and is not just a redirect to it.
//
// The copy avoids confirming whether the thing existed. "Not on your account"
// covers both the missing-receipt and the not-yours case without turning this
// page into an existence oracle for someone else's receipts or claims.
export default function ConsumerNotFound() {
  return (
    <NotFoundPanel
      // The group layout already supplies `min-h-dvh` and a `pb-24` gutter for
      // the bottom nav, so a second full-viewport block here would push the
      // page into a pointless scroll. Centre inside what the shell leaves.
      className="min-h-[calc(100dvh-6rem)]"
      title="We could not find that page"
      body="The link may be old, or the receipt or reward you are looking for is not on your account. Your points are safe."
      actions={[
        { label: "Go to my wallet", href: "/wallet", icon: "account_balance_wallet" },
        { label: "Back to home", href: "/home", icon: "home" },
      ]}
    />
  );
}
