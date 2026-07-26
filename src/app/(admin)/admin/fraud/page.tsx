import { notFound } from "next/navigation";

import { resolveAdminContext } from "@/features/admin/access";
import { isAdminFraudFilter } from "@/features/admin/presenter";
import { AdminQueueScreen } from "@/features/admin/queue-screen";
import { listAdminFraudQueue } from "@/features/admin/queue";
import type { AdminFraudFilter } from "@/features/admin/types";

// `/admin/fraud` - doc 37's platform-wide admin fraud queue.
//
// The `?filter=` parameter is caller-supplied and is validated against the
// three-value union before it reaches a query. It selects a WHERE clause and
// nothing else: there is no route segment or query parameter anywhere on this
// page that can name a business, a consumer or a receipt, because the queue is
// platform-wide by design and the only thing gating it is
// `resolveAdminContext()`.
export const dynamic = "force-dynamic";

type SearchParams = { filter?: string | string[] };

function readFilter(params: SearchParams): AdminFraudFilter {
  const raw = Array.isArray(params.filter) ? params.filter[0] : params.filter;
  return raw !== undefined && isAdminFraudFilter(raw) ? raw : "open";
}

export default async function AdminFraudPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const admin = await resolveAdminContext();
  if (admin === null) notFound();

  const filter = readFilter(await searchParams);
  const items = await listAdminFraudQueue({ filter });

  return (
    <AdminQueueScreen
      title="Fraud"
      subtitle="Every flagged receipt on the platform, whichever business it came from."
      kind="fraud"
      filter={filter}
      items={items ?? []}
      now={new Date()}
      // null means the read failed. Passed through as `unavailable` rather than
      // flattened to an empty list: an empty fraud queue is a claim that the
      // platform is clean, and a dropped connection cannot make it.
      unavailable={items === null}
    />
  );
}
