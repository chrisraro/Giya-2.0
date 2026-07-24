import type { ReactNode } from "react";
import { PortalShell } from "@/components/business/portal-shell";

// Dashboard chrome (sidebar + topbar) for every /business/* portal page
// EXCEPT onboarding, which lives outside this nested group and stays
// chrome-free. Stays a server component; PortalShell is the client glue
// that owns the shared mobile drawer state.
export default function PortalLayout({ children }: { children: ReactNode }) {
  return <PortalShell>{children}</PortalShell>;
}
