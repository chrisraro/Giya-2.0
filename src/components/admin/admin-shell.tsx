import type { ReactNode } from "react";

import { AdminNav } from "@/components/admin/admin-nav";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

// ===========================================================================
// Chrome for every `/admin` route.
//
// A SERVER COMPONENT, unlike `PortalShell`. That is not an oversight: the
// business shell is a client component because it owns the mobile drawer state
// the Sidebar and Topbar share, and this one has no drawer to own. Doc 31 is
// explicit that the admin portal is desktop-first ("Layout: persistent
// sidebar"), and a rail that is always visible needs no open/close state, no
// focus management and no client bundle. The one client component in this tree
// is `AdminNav`, which exists only because marking the current section needs
// the current path.
//
// TOKENS ONLY. Tertiary (Mango) does not appear anywhere in this tree: it is
// rewards language, and nothing an admin does here is a reward.
// ===========================================================================

export interface AdminShellProps {
  children: ReactNode;
  adminName: string;
  /** `platform_admins.role`, shown so an operator can see what they are acting as. */
  adminRole: string;
}

export function AdminShell({ children, adminName, adminRole }: AdminShellProps) {
  return (
    <div className="min-h-dvh bg-surface text-on-surface">
      <nav
        aria-label="Admin sections"
        className={cn(
          "border-b border-outline-variant bg-surface-container-low",
          "lg:fixed lg:inset-y-0 lg:left-0 lg:z-10 lg:w-60 lg:border-r lg:border-b-0",
        )}
      >
        <div className="flex items-center gap-2 px-4 py-4">
          <Logo className="h-6 w-auto" />
          <span className="rounded-full bg-surface-container-highest px-2 py-0.5 text-label-s text-on-surface-variant">
            Platform
          </span>
        </div>
        <AdminNav />
      </nav>

      <div className="flex min-h-dvh flex-col lg:pl-60">
        <header className="flex items-center justify-between gap-4 border-b border-outline-variant px-6 py-4">
          <p className="text-title-m text-on-surface">Platform administration</p>
          <p className="text-body-s text-on-surface-variant">
            {adminName}
            <span className="ml-2 rounded-full bg-surface-container-high px-2 py-0.5 text-label-s">
              {adminRole.replace("_", " ")}
            </span>
          </p>
        </header>

        {/*
          Every action taken from these screens is recorded. Said once, in the
          chrome, rather than in five confirm dialogs: doc 31 section 11's
          reason-required pattern works because operators know it is standing
          policy, and a notice that only appears at the moment of acting reads
          as a warning about that one action instead.
        */}
        <p className="border-b border-outline-variant bg-surface-container-low px-6 py-2 text-body-s text-on-surface-variant">
          Everything you do here is recorded against your name, with the reason you give.
        </p>

        <main className="flex-1 px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
