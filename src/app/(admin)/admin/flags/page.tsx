import { notFound } from "next/navigation";

import { resolveAdminContext } from "@/features/admin/access";
import { loadFeatureFlags } from "@/features/admin/flags";
import { FlagsScreen } from "@/features/admin/flags-screen";

// `/admin/flags` - doc 31 section 1: "super_admin only". doc 31 section 7's
// screen: list every `feature_flags` row, toggle `is_enabled`.
//
// A second, page-level `resolveAdminContext()` call, exactly as every other
// page under `(admin)` makes - `src/app/(admin)/admin/layout.tsx`'s own
// comment explains why the layout's gate alone is not enough. `canAct` here
// is `role === "super_admin"` specifically, NOT `canActOnLadder(admin.role)`
// (which also allows `admin`) - this screen's scope is narrower than the
// queue-status screen's, per doc 31 section 1's route table, because a kill
// switch is a platform-wide emergency brake and doc 01's persona matrix
// reserves that tier of control to the role account holders are directly
// accountable for. An `admin` or `support` session still renders the screen
// fully, read-only.
export const dynamic = "force-dynamic";

export default async function AdminFlagsPage() {
  const admin = await resolveAdminContext();
  if (admin === null) notFound();

  const flags = await loadFeatureFlags();

  return <FlagsScreen flags={flags} canAct={admin.role === "super_admin"} />;
}
