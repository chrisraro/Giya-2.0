import { notFound } from "next/navigation";

import { escalateReceiptAction } from "@/features/receipts/actions";
import { ReceiptStatus } from "@/features/receipts/components/receipt-status";
import { getMyReceipt } from "@/features/receipts/server/repo";
import { createClient } from "@/lib/supabase/server";

// /scan/[receiptId] - live processing status for one submission
// (doc 33 route inventory, MVP; doc 36 "Realtime status + optimistic wallet
// UX").
//
// The server does the first read so the screen paints its real state
// immediately. That matters more than it looks: the stub OCR provider (and,
// later, a warm queue) can settle a receipt inside the submit request itself,
// so a consumer redirected here often arrives at an already-approved receipt
// and should see the points, not a spinner that has nothing left to wait for.
// <ReceiptStatus> then subscribes only if the receipt is still moving.

export const dynamic = "force-dynamic";

type PageParams = { receiptId: string };

export default async function ReceiptStatusPage({ params }: { params: Promise<PageParams> }) {
  const { receiptId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  // getMyReceipt returns null both for "no such receipt" and for "exists but
  // is not yours" (RLS on receipts is a union that also admits the owning
  // business's staff, so RLS alone does not prove ownership). One
  // indistinguishable 404 for both, per doc 13 and matching the GET route.
  const receipt = await getMyReceipt(receiptId, user.id);
  if (!receipt) notFound();

  // The escalation action is passed down rather than imported by the client
  // component, which keeps <ReceiptStatus> unit-testable without a server
  // runtime. It takes a receipt id and nothing else; every guard, including the
  // one proving the caller submitted this receipt, is re-derived server side.
  return <ReceiptStatus receipt={receipt} onEscalate={escalateReceiptAction} />;
}
