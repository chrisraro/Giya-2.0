import { redirect } from "next/navigation";

import { EmptyState } from "@/components/consumer/empty-state";
import { resolveStaffContext } from "@/features/businesses/server/resolve-owner-business";
import { STAFF_ROSTER_ROLES } from "@/features/businesses/staff/roles";
import { StaffManager } from "@/features/businesses/staff/components/staff-manager";
import { loadRoster } from "@/features/businesses/staff/server/service";

// /business/staff - roster + invitations (doc 32 section 7.1).
//
// TENANCY: `resolveStaffContext` resolves the caller's business and role from
// `business_staff` under the caller's own session - the only id that reaches
// a query. There is no route segment or parameter here that can name a
// business or another caller's staff row.
export const dynamic = "force-dynamic";

export default async function BusinessStaffPage() {
  const context = await resolveStaffContext(STAFF_ROSTER_ROLES);
  if (context === null) {
    // The portal layout already redirected non-members; reaching here means
    // an active member whose role has no roster-view grant (doc 01 matrix:
    // marketing and staff are excluded, see roles.ts).
    redirect("/business/dashboard");
  }

  const roster = await loadRoster(context.businessId);
  if (!roster.ok || !roster.data) {
    return (
      <EmptyState icon="error" title="Could not load your staff" body="Refresh to try again." />
    );
  }

  return (
    <StaffManager
      businessName={context.businessName}
      roster={roster.data}
      actorRole={context.role}
    />
  );
}
