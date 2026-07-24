"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/business/dashboard", label: "Dashboard", icon: "space_dashboard" },
  { href: "/business/campaigns", label: "Campaigns", icon: "campaign" },
  { href: "/business/menu", label: "Menu", icon: "restaurant_menu" },
  { href: "/business/customers", label: "Customers", icon: "group" },
  { href: "/business/rewards", label: "Rewards", icon: "redeem" },
  { href: "/business/settings", label: "Settings", icon: "settings" },
] as const;

export interface SidebarProps {
  /** Whether the mobile drawer variant is open. Desktop rail always renders. */
  mobileOpen: boolean;
  onMobileClose: () => void;
}

function NavList({
  pathname,
  onNavigate = () => {},
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-full px-4 py-2.5 text-label-l outline-none transition-colors duration-200 ease-standard",
                "focus-visible:ring-2 focus-visible:ring-secondary",
                active
                  ? "bg-secondary-container text-on-secondary-container"
                  : "text-on-surface-variant hover:bg-surface-container-high",
              )}
            >
              <span
                aria-hidden
                className={cn("material-symbols-rounded text-[20px]", active && "is-filled")}
              >
                {item.icon}
              </span>
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Business portal navigation. Desktop renders a fixed 240px left rail.
 * Mobile renders a slide-in drawer (controlled by `mobileOpen`, triggered
 * from the Topbar hamburger) with a scrim, Escape-to-close, a Tab focus trap
 * scoped to the drawer, body scroll lock while open, and focus returning to
 * the trigger via `onMobileClose`.
 */
export function Sidebar({ mobileOpen, onMobileClose }: SidebarProps) {
  const pathname = usePathname();
  const reduce = useReducedMotion();
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLElement>(null);

  // Escape closes the drawer; Tab/Shift+Tab is trapped among the drawer's
  // own focusable elements so keyboard focus cannot escape into the page
  // behind the scrim while the drawer is open.
  React.useEffect(() => {
    if (!mobileOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onMobileClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;

      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled])",
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen, onMobileClose]);

  // Lock body scroll while the drawer is open; restore whatever it was on close/unmount.
  React.useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileOpen]);

  React.useEffect(() => {
    if (mobileOpen) closeButtonRef.current?.focus();
  }, [mobileOpen]);

  return (
    <>
      {/* Desktop rail: fixed 240px (w-60) left column */}
      <nav
        aria-label="Business"
        className={cn(
          "hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex lg:w-60 lg:flex-col lg:gap-6",
          "lg:border-r lg:border-outline-variant lg:bg-surface-container lg:px-4 lg:py-6",
        )}
      >
        <Link
          href="/business/dashboard"
          aria-label="Giya business home"
          className="px-2 text-secondary outline-none focus-visible:ring-2 focus-visible:ring-secondary"
        >
          <Logo variant="lockup" />
        </Link>
        <NavList pathname={pathname} />
      </nav>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              key="sidebar-scrim"
              aria-hidden
              onClick={onMobileClose}
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduce ? {} : { opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.2 }}
              className="fixed inset-0 z-40 bg-scrim/40 lg:hidden"
            />
            <motion.nav
              key="sidebar-panel"
              ref={panelRef}
              aria-label="Business"
              role="dialog"
              aria-modal="true"
              initial={reduce ? false : { x: "-100%" }}
              animate={{ x: 0 }}
              exit={reduce ? {} : { x: "-100%" }}
              transition={{ duration: reduce ? 0 : 0.25, ease: [0.05, 0.7, 0.1, 1] }}
              className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[80vw] flex-col gap-6 bg-surface-container px-4 py-6 lg:hidden"
            >
              <div className="flex items-center justify-between">
                <Link
                  href="/business/dashboard"
                  aria-label="Giya business home"
                  onClick={onMobileClose}
                  className="px-2 text-secondary outline-none focus-visible:ring-2 focus-visible:ring-secondary"
                >
                  <Logo variant="lockup" />
                </Link>
                <button
                  ref={closeButtonRef}
                  type="button"
                  aria-label="Close navigation"
                  onClick={onMobileClose}
                  className={cn(
                    "flex size-10 items-center justify-center rounded-full text-on-surface-variant outline-none",
                    "transition-colors duration-200 ease-standard hover:bg-surface-container-high",
                    "focus-visible:ring-2 focus-visible:ring-secondary",
                  )}
                >
                  <span aria-hidden className="material-symbols-rounded">
                    close
                  </span>
                </button>
              </div>
              <NavList pathname={pathname} onNavigate={onMobileClose} />
            </motion.nav>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
