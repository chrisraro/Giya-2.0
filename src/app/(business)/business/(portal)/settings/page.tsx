import { redirect } from "next/navigation";

import { EmptyState } from "@/components/consumer/empty-state";
import { BUSINESS_SETTINGS_ROLES } from "@/features/businesses/settings/roles";
import { SettingsForm } from "@/features/businesses/settings/components/settings-form";
import { loadProfile } from "@/features/businesses/settings/server/service";
import { resolveStaffContext } from "@/features/businesses/server/resolve-owner-business";

// /business/settings - the tenant's own details (doc 32 sections 4 and 13).
//
// TENANCY: `resolveStaffContext` resolves the caller's business and role from
// `business_staff` under the caller's own session; that id is the only one that
// reaches a query or an update. This route has no segment and no parameter.
//
// WHAT THIS SCREEN CANNOT WRITE, and why it matters here more than elsewhere:
// `businesses_staff_update` is row-scoped, so an owner's session technically
// carries UPDATE on every column of their own row, including `status`,
// `verified_at` and `plan`. supabase/README.md's "Known limitations" records
// that gap and marks the column-level grant as owed. Until it exists, the fence
// is code: the strict input schema
// (src/features/businesses/settings/schemas.ts) refuses a payload that even
// names those columns, and the repo asserts the allowlist a second time before
// the query.
export const dynamic = "force-dynamic";

export default async function BusinessSettingsPage() {
  const context = await resolveStaffContext(BUSINESS_SETTINGS_ROLES);
  if (context === null) {
    // The portal layout already redirected non-members; reaching here means an
    // active member whose role cannot edit the profile (doc 01 matrix "Edit
    // profile/hours/gallery": owner and manager only).
    redirect("/business/dashboard");
  }

  const profile = await loadProfile(context.businessId);

  // A failed read is not a blank business. Rendering an empty form would invite
  // the merchant to retype their details over data that is still there - the
  // same query-error-versus-empty distinction menu/page.tsx makes.
  if (!profile.ok || !profile.data) {
    return (
      <EmptyState
        icon="error"
        title="Could not load your business details"
        body="Refresh to try again."
      />
    );
  }

  return <SettingsForm profile={profile.data} />;
}
