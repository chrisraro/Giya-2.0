import { notFound } from "next/navigation";

import { canActOnLadder, resolveAdminContext } from "@/features/admin/access";
import { loadAdminReceiptDetail } from "@/features/admin/queue";
import { AdminReceiptScreen } from "@/features/admin/receipt-screen";

// `/admin/receipts/[receiptId]` - one receipt, cross-tenant, with the ladder.
//
// `receiptId` is the only caller-supplied value on this page and it is NOT
// paired with a tenancy predicate, unlike its business sibling, which pairs it
// with a resolved business id in the same WHERE clause. That is correct here
// and dangerous anywhere else: this screen exists precisely to open a receipt
// that belongs to no tenant the caller is a member of, so the fence is
// `resolveAdminContext()` and there is nothing else standing behind it.
//
// A null detail is a real 404 - "no such receipt" - which is safe to say to an
// admin because an admin may see every receipt, so the answer carries no
// information they could not have obtained from the queue.
export const dynamic = "force-dynamic";

export default async function AdminReceiptDetailPage({
  params,
}: {
  params: Promise<{ receiptId: string }>;
}) {
  const admin = await resolveAdminContext();
  if (admin === null) notFound();

  const { receiptId } = await params;
  const detail = await loadAdminReceiptDetail({ receiptId });
  if (detail === null) notFound();

  return (
    <AdminReceiptScreen
      detail={detail}
      // doc 01's matrix: `support` reads everything and mutates nothing. The
      // panel renders disabled with an explanation rather than hidden, so a
      // support operator can see what an admin would be able to do and ask for
      // it, instead of wondering whether the page is broken.
      canAct={canActOnLadder(admin.role)}
      now={new Date()}
    />
  );
}
