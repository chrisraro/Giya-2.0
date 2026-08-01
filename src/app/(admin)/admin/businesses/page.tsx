import { notFound } from "next/navigation";

import { canActOnLadder, resolveAdminContext } from "@/features/admin/access";
import { listBusinessesAwaitingReview } from "@/features/admin/businesses";
import { AdminBusinessesScreen } from "@/features/admin/businesses-screen";

// `/admin/businesses` - doc 31 section 3's verification queue, and the other
// half of doc 32 section 2's lifecycle diagram.
//
// This route is the reason migration 0033 exists. `businesses.status` defaults
// to 'draft', every consumer-facing read filters `status='active'`, and until
// now nothing in the product moved a business between the two: a merchant
// signed up, finished onboarding, got a portal that looked like it worked, and
// was invisible to every consumer forever without a single error anywhere.
// `activate_business` is the only path across that line, and this page is the
// only surface that calls it.
//
// `resolveAdminContext()` is called here as well as in the layout, which is the
// portal's standing pattern: `src/app/design/page.tsx` records that a layout
// guard can leak because a layout receives `children` already resolved, so
// every page under `(admin)` gates itself too.
export const dynamic = "force-dynamic";

export default async function AdminBusinessesPage() {
  const admin = await resolveAdminContext();
  if (admin === null) notFound();

  const items = await listBusinessesAwaitingReview();

  return (
    <AdminBusinessesScreen
      items={items ?? []}
      now={new Date()}
      // doc 01's matrix: `support` is read-only everywhere. The panel renders
      // for them and disables every control, rather than hiding the queue,
      // because reading it is precisely what a support account is for.
      canAct={canActOnLadder(admin.role)}
      unavailable={items === null}
    />
  );
}
