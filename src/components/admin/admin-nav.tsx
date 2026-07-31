"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

// ===========================================================================
// The admin rail's link list.
//
// The ONLY client component in the admin chrome, and it is one for a single
// reason: marking the current section requires the current path, and
// `usePathname()` is how a component knows it. Everything else in `AdminShell`
// stays server-rendered.
//
// The alternative was reading the path from a request header in the layout and
// passing it down, which keeps this file server-side. It was tried and dropped:
// the header Next exposes for that is an internal, has changed name across
// versions, and a rail that silently stops highlighting after an upgrade is a
// worse trade than the few hundred bytes this costs.
//
// No mobile drawer, unlike the business sidebar: doc 31 makes the admin portal
// desktop-first with a persistent sidebar, so on a narrow screen this becomes a
// scrollable strip of the same links rather than an interaction model with
// state, focus management and an escape key.
// ===========================================================================

const NAV_ITEMS = [
  { href: "/admin", label: "Overview", icon: "space_dashboard", exact: true },
  // Businesses sits directly under Overview, above the two receipt queues, and
  // the order is the point: a merchant on that list cannot trade at all, while
  // a receipt on the other two is one transaction for a merchant who can. The
  // more expensive queue to leave sitting goes first.
  { href: "/admin/businesses", label: "Businesses", icon: "storefront", exact: false },
  { href: "/admin/fraud", label: "Fraud", icon: "gpp_maybe", exact: false },
  { href: "/admin/receipts", label: "Receipts", icon: "receipt_long", exact: false },
] as const;

export function AdminNav() {
  const pathname = usePathname();

  return (
    <ul className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible">
      {NAV_ITEMS.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(`${item.href}/`);

        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 whitespace-nowrap rounded-full px-4 py-2.5 text-label-l",
                "outline-none transition-colors duration-200 ease-standard motion-reduce:transition-none",
                "focus-visible:ring-2 focus-visible:ring-primary",
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
