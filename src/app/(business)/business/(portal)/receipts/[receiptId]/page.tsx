import { notFound, redirect } from "next/navigation";

import {
  approveReceiptAction,
  learnMerchantAliasAction,
  rejectReceiptAction,
} from "@/features/receipts/review/actions";
import { resolveReviewerContext } from "@/features/receipts/review/access";
import { ReviewDecisionScreen } from "@/features/receipts/review/decision-screen";
import { loadReviewDecisionItem } from "@/features/receipts/review/queue";

// /business/receipts/[receiptId] - the decision screen (doc 36 Stage 9's UI
// contract, doc 37's evidence display contract, spec section 5).
//
// The `[receiptId]` segment is the only caller-supplied value in this slice
// that reaches a query, and `loadReviewDecisionItem` pairs it with the
// resolved business id in the same WHERE clause. A receipt belonging to
// another tenant therefore resolves to null, and null renders the SAME 404 as
// a receipt that does not exist: distinguishing them would turn this route
// into an oracle for other tenants' receipt ids.
//
// The two server actions are passed as props rather than imported by the
// client component, which keeps the decision screen a pure function of its
// props and therefore testable without a Next runtime.
export const dynamic = "force-dynamic";

type PageParams = { receiptId: string };

export default async function BusinessReceiptDecisionPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const reviewer = await resolveReviewerContext();
  if (reviewer === null) {
    redirect("/business/dashboard");
  }

  const { receiptId } = await params;

  const item = await loadReviewDecisionItem({
    businessId: reviewer.businessId,
    receiptId,
    viewerId: reviewer.userId,
  });
  if (item === null) notFound();

  return (
    <ReviewDecisionScreen
      item={item}
      businessName={reviewer.businessName}
      now={new Date()}
      onApprove={approveReceiptAction}
      onReject={rejectReceiptAction}
      onLearnAlias={learnMerchantAliasAction}
    />
  );
}
