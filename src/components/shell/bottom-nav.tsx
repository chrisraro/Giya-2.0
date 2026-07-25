"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// Four destinations plus the centre Scan FAB. MD3's navigation bar tops out
// at five destinations, and the FAB already occupies the fifth slot inside a
// max-w-md row, so this list is full.
//
// /receipts IS NOT HERE ON PURPOSE. It was unreachable on a fresh account and
// the tempting fix was to add it as a fifth item, which would have meant six
// tap targets in a 448px row and would have broken the symmetric two-FAB-two
// layout for a screen people visit occasionally, not constantly. Receipt
// history is a detail view of the wallet, so the wallet is where it is linked
// from: WalletReceiptActivity's "See all" now renders even when the consumer
// has zero receipts (it used to hide the whole section, which is what made
// the route unreachable). Every entry here is a top-level place; /receipts is
// somewhere you go from one.
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
