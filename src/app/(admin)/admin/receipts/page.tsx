import { notFound } from "next/navigation";

import { resolveAdminContext } from "@/features/admin/access";
import { isAdminReceiptFilter } from "@/features/admin/presenter";
import { AdminQueueScreen } from "@/features/admin/queue-screen";
import { listAdminReceipts } from "@/features/admin/queue";
import type { AdminReceiptFilter } from "@/features/admin/types";

// `/admin/receipts` - doc 31 §5's cross-tenant receipt queue.
//
// The `unmatched` filter is the one that only exists here. 0017 shipped
// `receipts` with a staff policy scoped to `business_id` and warned in its own
// comment that a receipt with a null `business_id` "lands in a queue that no
// audience on this database can select, and it would sit there forever". 0031
// added the admin policy and this filter is the surface that reads it.
export const dynamic = "force-dynamic";

type SearchParams = { filter?: string | string[] };

function readFilter(params: SearchParams): AdminReceiptFilter {
  const raw = Array.isArray(params.filter) ? params.filter[0] : params.filter;
  return raw !== undefined && isAdminReceiptFilter(raw) ? raw : "review";
}

export default async function AdminReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const admin = await resolveAdminContext();
  if (admin === null) notFound();

  const filter = readFilter(await searchParams);
  const items = await listAdminReceipts({ filter });

  return (
    <AdminQueueScreen
      title="Receipts"
      subtitle="Every business's receipts, including the ones no business can see."
      kind="receipts"
      filter={filter}
      items={items ?? []}
      now={new Date()}
      unavailable={items === null}
    />
  );
}
