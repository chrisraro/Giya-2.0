import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { PortalShell } from "@/components/business/portal-shell";
import { createClient } from "@/lib/supabase/server";

// Dashboard chrome (sidebar + topbar) for every /business/* portal page
// EXCEPT onboarding, which lives outside this nested group and stays
// chrome-free. Stays a server component; PortalShell is the client glue
// that owns the shared mobile drawer state.
//
// The verification banner's businessStatus is intentionally NOT fetched
// here: `children` is already the resolved page element by the time this
// layout runs, so there is no clean way to inject a prop into it from
// above, and only the dashboard page needs the value. The dashboard page
// (a server component) fetches it directly instead. See its
// getBusinessStatus() for details.
//
// Membership enforcement lives here, not in middleware (doc 12: claims are
// hints, tables are truth). middleware.ts only checks for a session; this
// layout is the authoritative gate, querying business_staff directly so it
// is correct even before the custom access token hook stamps biz claims
// into a user's JWT (or if the hook isn't enabled at all).
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Belt and braces: middleware already redirects unauthenticated users
    // away from portal routes, but a server component rendering business
    // data should not rely on that alone.
    redirect("/login");
  }

  // Migration 0004 added a business_staff self-select RLS policy, so a
  // signed-in user can always read their own membership rows regardless of
  // what (if anything) their JWT's claims say.
  const { data: membership } = await supabase
    .from("business_staff")
    .select("business_id")
    .eq("user_id", user.id)
    .eq("status", "active")
    .limit(1);

  if (!membership || membership.length === 0) {
    redirect("/business/onboarding");
  }

  return <PortalShell>{children}</PortalShell>;
}
