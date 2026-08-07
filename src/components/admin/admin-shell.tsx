import type { ReactNode } from "react";

import { AdminNav } from "@/components/admin/admin-nav";
import { Logo } from "@/components/brand/logo";
import { signOut } from "@/features/identity/actions";
import { cn } from "@/lib/utils";

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
          <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-label-s font-semibold text-primary">
            ERP Control
          </span>
        </div>
        <AdminNav />
      </nav>

      <div className="flex min-h-dvh flex-col lg:pl-60">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-outline-variant bg-surface-container-lowest px-4 sm:px-6 py-3.5 shadow-xs">
          <div className="flex items-center gap-3">
            <span className="flex size-3 items-center justify-center">
              <span className="absolute size-2.5 animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="size-2 rounded-full bg-emerald-500" />
            </span>
            <div className="flex flex-col">
              <p className="text-title-m font-semibold text-on-surface">Platform ERP Command Center</p>
              <p className="text-label-s text-on-surface-variant">Live System Operational Status: Healthy</p>
            </div>
          </div>

          <div className="flex items-center justify-between sm:justify-end gap-3">
            <div className="flex items-center gap-2 rounded-full border border-outline-variant bg-surface-container px-3 py-1.5">
              <span className="flex size-7 items-center justify-center rounded-full bg-primary text-label-m font-bold text-on-primary">
                {adminName.slice(0, 1).toUpperCase()}
              </span>
              <div className="flex flex-col text-left">
                <span className="text-label-m font-medium text-on-surface">{adminName}</span>
                <span className="text-label-s text-on-surface-variant capitalize">
                  {adminRole.replace("_", " ")}
                </span>
              </div>
            </div>

            <form action={signOut}>
              <button
                type="submit"
                className={cn(
                  "flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container-high px-3 py-1.5 text-label-m font-medium text-on-surface",
                  "transition-colors duration-150 hover:border-error hover:bg-error-container/30 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error",
                )}
                title="Sign out of Admin Portal"
              >
                <span className="material-symbols-rounded text-[18px]">logout</span>
                <span>Sign Out</span>
              </button>
            </form>
          </div>
        </header>

        <p className="border-b border-outline-variant bg-surface-container-low px-4 sm:px-6 py-2 text-body-s text-on-surface-variant flex items-center gap-2">
          <span className="material-symbols-rounded text-[16px] text-primary">security</span>
          <span>Audit Active: Everything you do here is recorded against your name, with the reason you give.</span>
        </p>

        <main className="flex-1 px-4 sm:px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
