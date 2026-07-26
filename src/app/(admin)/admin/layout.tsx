import type { ReactNode } from "react";
import { notFound } from "next/navigation";

import { AdminShell } from "@/components/admin/admin-shell";
import { resolveAdminContext } from "@/features/admin/access";

// ===========================================================================
// The gate for `/admin/*`.
//
// ---------------------------------------------------------------------------
// WHY notFound() AND NOT redirect().
// ---------------------------------------------------------------------------
// The business portal layout redirects a member-less caller to onboarding,
// which is right there: "you are signed in, you have no business, here is how
// to get one" is a helpful answer to a question the caller asked.
//
// A non-admin asking for `/admin` asked no such question. A redirect - or a
// "you do not have permission" page - answers it anyway, and the answer is
// "this route exists and you are not on the list". That is the first sentence
// of a targeted attack: it tells an attacker the surface is real, that platform
// admins exist, and that finding one of them is worth the effort. `notFound()`
// renders the same 404 an unrouted path renders, so `/admin` is
// indistinguishable from `/adminn` to everyone who is not an admin.
//
// ---------------------------------------------------------------------------
// WHY THE GATE IS HERE AND NOT IN MIDDLEWARE.
// ---------------------------------------------------------------------------
// Doc 12: claims are hints, tables are truth. Middleware sees a JWT and nothing
// else, and `is_platform_admin` in that JWT is up to an hour stale - an admin
// deactivated ten minutes ago still carries it. Doc 12 requires that
// destructive-permission checks verify against the table server-side, and the
// actions behind this layout are suspension and clawback. So the authoritative
// check is `resolveAdminContext()`, which reads `platform_admins` under the
// caller's own session, exactly as the business portal layout reads
// `business_staff` rather than trusting the `biz` claim.
//
// Middleware still matters for a different job: `/admin/*` matches the existing
// matcher, so an unauthenticated request is already bounced to `/login` before
// it reaches here. That is a convenience, not the fence, and this layout does
// not rely on it - `resolveAdminContext()` returns null for no session too, and
// null takes the same 404 path.
//
// A LAYOUT IS THE RIGHT PLACE, with one caveat this codebase already learned:
// `src/app/design/page.tsx` records that a layout guard leaked, because a
// layout receives `children` already resolved, so the page's tree still reached
// the RSC payload inside the 404. That case was a STATIC page. These pages are
// `force-dynamic` and every one of them calls `resolveAdminContext()` itself
// before reading anything, so a page under this layout renders nothing for a
// non-admin even if the layout's 404 were bypassed entirely. Two independent
// checks, which is what the design-page lesson costs.
// ===========================================================================

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const admin = await resolveAdminContext();
  if (admin === null) {
    notFound();
  }

  return (
    <AdminShell adminName={admin.displayName} adminRole={admin.role}>
      {children}
    </AdminShell>
  );
}
