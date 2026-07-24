"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/business/sidebar";
import { Topbar } from "@/components/business/topbar";

const PAGE_TITLES: Record<string, string> = {
  "/business/dashboard": "Dashboard",
  "/business/campaigns": "Campaigns",
  "/business/menu": "Menu",
  "/business/customers": "Customers",
  "/business/rewards": "Rewards",
  "/business/settings": "Settings",
};

/**
 * Client glue that owns the mobile drawer state shared between the Sidebar
 * (renders the drawer) and the Topbar (renders the hamburger that opens it).
 * Kept separate from the route layout so the layout and its page children
 * stay server components.
 */
export function PortalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const title = PAGE_TITLES[pathname] ?? "Dashboard";

  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const menuButtonRef = React.useRef<HTMLButtonElement>(null);

  function closeMobileNav() {
    setMobileNavOpen(false);
    menuButtonRef.current?.focus();
  }

  return (
    <div className="min-h-dvh bg-surface text-on-surface">
      <Sidebar mobileOpen={mobileNavOpen} onMobileClose={closeMobileNav} />
      <div className="flex min-h-dvh flex-col lg:pl-60">
        <Topbar
          title={title}
          onMenuClick={() => setMobileNavOpen(true)}
          menuButtonRef={menuButtonRef}
        />
        <main className="flex-1 px-4 py-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
