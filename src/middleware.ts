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

// Exact-match-or-child-path check, e.g. isOnboardingRoute("/onboarding/1")
// is true but isOnboardingRoute("/onboarding-other") is false.
function isOnboardingRoute(pathname: string): boolean {
  return pathname === "/onboarding" || pathname.startsWith("/onboarding/");
}

function isBusinessOnboardingRoute(pathname: string): boolean {
  return pathname === "/business/onboarding" || pathname.startsWith("/business/onboarding/");
}

export async function middleware(request: NextRequest) {
  const { response, user } = await updateSession(request);
  const { pathname } = request.nextUrl;

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

  if ((onOnboardingRoute || isBusinessPortalRoute) && !user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return copySessionCookies(response, NextResponse.redirect(loginUrl));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon|brand/).*)"],
};
