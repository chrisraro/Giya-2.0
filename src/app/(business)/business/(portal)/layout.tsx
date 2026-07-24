import type { ReactNode } from "react";
import { PortalShell } from "@/components/business/portal-shell";

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
export default function PortalLayout({ children }: { children: ReactNode }) {
  return <PortalShell>{children}</PortalShell>;
}
