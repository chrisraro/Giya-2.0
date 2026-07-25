"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/business/sidebar";
import { Topbar } from "@/components/business/topbar";

const PAGE_TITLES: Record<string, string> = {
  "/business/dashboard": "Dashboard",
  "/business/redeem": "Redeem",
  "/business/receipts": "Receipts",
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
export function PortalShell({
  children,
  pendingReviewCount = 0,
}: {
  children: React.ReactNode;
  /** Resolved server-side in the portal layout; feeds the sidebar badge. */
  pendingReviewCount?: number;
}) {
  const pathname = usePathname();
  // The decision screen is a child route, so the topbar title has to fall back
  // along the path rather than matching it exactly.
  const title =
    PAGE_TITLES[pathname] ??
    (pathname.startsWith("/business/receipts") ? "Receipts" : "Dashboard");

  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const menuButtonRef = React.useRef<HTMLButtonElement>(null);

  function closeMobileNav() {
    setMobileNavOpen(false);
    menuButtonRef.current?.focus();
  }

  return (
    <div className="min-h-dvh bg-surface text-on-surface">
      <Sidebar
        mobileOpen={mobileNavOpen}
        onMobileClose={closeMobileNav}
        pendingReviewCount={pendingReviewCount}
      />
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
