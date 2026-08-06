import { notFound } from "next/navigation";

import { canActOnLadder, resolveAdminContext } from "@/features/admin/access";
import { loadQueueStatus } from "@/features/admin/jobs";
import { QueueStatusScreen } from "@/features/admin/queue-status-screen";

// `/admin/monitoring/queues` - doc 31 §5, doc 39's Queue Status screen.
//
// A second, page-level `resolveAdminContext()` call, exactly as every other
// page under `(admin)` makes - `src/app/(admin)/admin/layout.tsx`'s own
// comment explains why the layout's gate alone is not enough (the design
// page's leaked-static-render lesson). `canActOnLadder(admin.role)` is the
// second thing this page resolves: doc 31 §5 scopes replay to
// admin/super_admin, and `support` must see this screen fully but act on
// none of it - the screen renders read-only rather than refusing to render.
export const dynamic = "force-dynamic";

export default async function AdminQueuesPage() {
  const admin = await resolveAdminContext();
  if (admin === null) notFound();

  const status = await loadQueueStatus();

  return <QueueStatusScreen {...status} canAct={canActOnLadder(admin.role)} />;
}
