"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const DESTINATIONS = [
  { href: "/home", label: "Home", icon: "home" },
  { href: "/wallet", label: "Wallet", icon: "account_balance_wallet" },
  { href: "/rewards", label: "Rewards", icon: "redeem" },
  { href: "/profile", label: "Profile", icon: "person" },
] as const;

function NavItem({ href, label, icon }: (typeof DESTINATIONS)[number]) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className="flex min-w-16 flex-col items-center gap-1 py-2 outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span
        className={cn(
          "flex h-8 w-14 items-center justify-center rounded-full transition-colors duration-200 ease-standard",
          active && "bg-primary-container",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "material-symbols-rounded",
            active ? "is-filled text-on-primary-container" : "text-on-surface-variant",
          )}
        >
          {icon}
        </span>
      </span>
      <span className={cn("text-label-m", active ? "text-on-surface" : "text-on-surface-variant")}>
        {label}
      </span>
    </Link>
  );
}

export function BottomNav() {
  const [first, second, third, fourth] = DESTINATIONS;
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-outline-variant bg-surface-container pb-[env(safe-area-inset-bottom)]"
    >
      <div className="mx-auto flex max-w-md items-center justify-between px-2">
        <NavItem {...first} />
        <NavItem {...second} />
        <Link
          href="/scan"
          aria-label="Scan receipt"
          className={cn(
            "flex size-14 -translate-y-3 items-center justify-center rounded-md3-lg",
            "bg-tertiary-container text-on-tertiary-container shadow-lg",
            "transition-transform duration-200 ease-emphasized active:scale-95",
            "outline-none focus-visible:ring-2 focus-visible:ring-primary",
          )}
        >
          <span aria-hidden className="material-symbols-rounded">document_scanner</span>
        </Link>
        <NavItem {...third} />
        <NavItem {...fourth} />
      </div>
    </nav>
  );
}
