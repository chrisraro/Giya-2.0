import { NextResponse, type NextRequest } from "next/server";

import { updateSession, type BizClaims } from "@/lib/supabase/middleware";

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
  const { response, user, claims } = await updateSession(request);
  const { pathname } = request.nextUrl;

  const onOnboardingRoute = isOnboardingRoute(pathname) || isBusinessOnboardingRoute(pathname);

  // Business portal routes require both a user and membership claims.
  // The exact marketing page `/business` and `/business/onboarding` are
  // excluded here so they can be handled by the onboarding rule above (or,
  // for `/business` itself, stay fully public).
  const isBusinessPortalRoute =
    pathname.startsWith("/business/") && !isBusinessOnboardingRoute(pathname);

  if ((onOnboardingRoute || isBusinessPortalRoute) && !user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return copySessionCookies(response, NextResponse.redirect(loginUrl));
  }

  if (isBusinessPortalRoute && user && !hasBusinessMembership(claims)) {
    return copySessionCookies(
      response,
      NextResponse.redirect(new URL("/business/onboarding", request.url)),
    );
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon|brand/).*)"],
};
