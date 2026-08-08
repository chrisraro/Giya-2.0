import { NextResponse, type NextRequest } from "next/server";

import { updateSession, type BizClaims } from "@/lib/supabase/middleware";

// Fast-path helper only, NOT wired into portal enforcement below anymore.
// Doc 12: claims are hints, tables are truth. A just-registered owner's JWT
// lacks the biz claim (the token hook stamps it at issuance, but may not
// even be enabled), so gating on claims here bounce-loops real owners back
// to onboarding. The authoritative check now lives in the portal layout,
// which queries business_staff directly. This is kept exported (and unit
// tested) as a candidate for a future cheap client-side hint or
// cache-warming shortcut once the hook is reliably enabled.
export function hasBusinessMembership(claims: BizClaims): boolean {
  const biz = claims.biz;
  const hasBiz = !!biz && typeof biz === "object" && Object.keys(biz).length > 0;
  return hasBiz || claims.biz_overflow === true;
}

// Copies every cookie set on `source` onto `target` and returns `target`.
// updateSession() may have refreshed the session's access/refresh token
// cookies onto its response; when we redirect instead of returning that
// response directly, those refreshed cookies must be carried over or the
// refresh is silently dropped and the client keeps sending a stale (or
// soon-to-expire) session token.
export function copySessionCookies(source: NextResponse, target: NextResponse): NextResponse {
  for (const cookie of source.cookies.getAll()) {
    target.cookies.set(cookie);
  }
  return target;
}

// NOTE ON /design, WHICH IS DELIBERATELY NOT HANDLED HERE.
//
// `/design` is the internal MD3 swatch board, and it was publicly live in
// production because this file's matcher only ever excluded `_next`,
// `favicon` and `brand/`. The obvious fix was a branch in this function that
// rewrote it away outside development, and that was tried and rejected: a
// middleware rewrite to an unmatched path renders the app's 404 page but
// answers HTTP 200 for `/design` itself (measured; child paths did answer
// 404). A soft 404 is worse than the problem, because it is indexable.
//
// The gate lives in `src/app/design/page.tsx` instead, where `notFound()` is
// the framework's own documented way to produce a real 404, and where the
// build prerenders the answer rather than deciding it per request. A shared
// `layout.tsx` guard was also tried and also leaked (a layout receives
// `children` already resolved, so the page's tree still reached the RSC
// payload inside the 404). See that page and `src/app/design/dev-only.ts`.

// Exact-match-or-child-path check, e.g. isOnboardingRoute("/onboarding/1")
// is true but isOnboardingRoute("/onboarding-other") is false.
function isOnboardingRoute(pathname: string): boolean {
  return pathname === "/onboarding" || pathname.startsWith("/onboarding/");
}

function isBusinessOnboardingRoute(pathname: string): boolean {
  return pathname === "/business/onboarding" || pathname.startsWith("/business/onboarding/");
}

function isAdminRoute(pathname: string): boolean {
  return pathname === "/admin" || (pathname.startsWith("/admin/") && !pathname.startsWith("/admin/login"));
}

/**
 * Consumer routes that are meaningless without a session and must bounce to
 * /login rather than render an empty or broken screen.
 *
 * WHY THESE SEVEN, AND WHY NOT THE OTHERS:
 *
 *   * `/home`     - the worst of the set. It rendered a greeting by name over a
 *                   points total and a balance strip, so an anonymous visitor
 *                   was shown something that reads as a personal account. It
 *                   now reads real per-consumer data, which an anonymous
 *                   caller has none of, and there is no honest signed-out
 *                   version of "Magandang umaga, <name>".
 *   * `/profile`  - by definition somebody's profile: their name, email, city
 *                   and the sign-out control.
 *   * `/wallet`   - RLS returns nothing to an anonymous caller, so a signed-out
 *                   visitor got a fully rendered "Wallet / No balances yet"
 *                   page that looks like an empty account rather than a
 *                   signed-out one.
 *   * `/rewards`  - the public reward catalogue renders, but every Claim button
 *                   fails with "You need to be signed in to do that" only AFTER
 *                   the tap. Better to ask up front.
 *   * `/scan`     - the whole flow ends in a 401 at submit.
 *   * `/receipts` - answered `notFound()` for a signed-out visitor, which is a
 *                   correct status but the wrong recovery: "sign in" is the
 *                   action, not "this page does not exist". Its own
 *                   `notFound()` stays as belt and braces.
 *   * `/notifications` - doc 33 registers it as an auth route, and an inbox is
 *                   by definition somebody's inbox. 0026 revokes SELECT on
 *                   `notifications` from `anon` entirely, so an ungated
 *                   signed-out visit would render an empty "You are all caught
 *                   up" that reads as an account with no messages rather than
 *                   as no account. The page redirects on its own too.
 *
 * NOT gated here:
 *   * `/b/[slug]` - deliberately public. It is a business's shareable page and
 *                   a link to it must work for someone with no account. It is
 *                   also where /home's shop cards point, so gating it would
 *                   break the one public route out of the consumer app.
 *
 * Middleware is the gate, but not the only one: /home and /profile also check
 * for a session themselves and redirect, so the guarantee does not depend on
 * this matcher staying correct.
 */
const AUTHENTICATED_CONSUMER_ROUTES = [
  "/home",
  "/profile",
  "/wallet",
  "/rewards",
  "/scan",
  "/receipts",
  "/notifications",
] as const;

export function isAuthenticatedConsumerRoute(pathname: string): boolean {
  return AUTHENTICATED_CONSUMER_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const { response, user } = await updateSession(request);

  const onOnboardingRoute = isOnboardingRoute(pathname) || isBusinessOnboardingRoute(pathname);

  // Business portal routes require only a session here. The exact
  // marketing page `/business` and `/business/onboarding` are excluded so
  // they can be handled by the onboarding rule above (or, for `/business`
  // itself, stay fully public). Membership enforcement (does this user
  // actually belong to a business?) is NOT done here anymore; it happens
  // server-side in the portal layout via a business_staff table query,
  // since claims are hints and tables are truth (doc 12).
  const isBusinessPortalRoute =
    pathname.startsWith("/business/") && !isBusinessOnboardingRoute(pathname);

  const isAdmin = isAdminRoute(pathname);

  const needsSession =
    onOnboardingRoute || isBusinessPortalRoute || isAdmin || isAuthenticatedConsumerRoute(pathname);

  if (needsSession && !user) {
    const targetLogin = isAdmin ? "/admin/login" : "/login";
    const loginUrl = new URL(targetLogin, request.url);
    loginUrl.searchParams.set("next", pathname);
    return copySessionCookies(response, NextResponse.redirect(loginUrl));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon|brand/).*)"],
};
