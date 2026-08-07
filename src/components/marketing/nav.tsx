"use client";

import { useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/business/signup", label: "For businesses" },
  { href: "/business/login", label: "Merchant Portal" },
  { href: "/#faq", label: "FAQ" },
] as const;

export function MarketingNav() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-outline-variant/60 bg-surface/90 backdrop-blur">
      <nav aria-label="Main" className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link href="/" aria-label="Giya home" className="text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <Logo variant="lockup" />
        </Link>
        <div className="hidden items-center gap-4 md:flex">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="text-label-l text-on-surface-variant transition-colors hover:text-on-surface">
              {l.label}
            </Link>
          ))}
          <Link href="/home" className={buttonVariants({ variant: "filled", size: "md" })}>
            Open Giya
          </Link>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen(!open)}
          className="flex size-12 items-center justify-center rounded-full text-on-surface md:hidden"
        >
          <span aria-hidden className="material-symbols-rounded">{open ? "close" : "menu"}</span>
        </button>
      </nav>
      {open && (
        <div className="border-t border-outline-variant bg-surface px-4 py-4 md:hidden">
          <div className="flex flex-col gap-1">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="rounded-md3-sm px-3 py-3 text-body-l text-on-surface hover:bg-surface-container">
                {l.label}
              </Link>
            ))}
            <Link href="/home" onClick={() => setOpen(false)} className={cn(buttonVariants({ variant: "filled", size: "touch" }), "mt-2")}>
              Open Giya
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
