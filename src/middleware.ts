import { NextResponse, type NextRequest } from "next/server";

import { updateSession, type BizClaims } from "@/lib/supabase/middleware";

function hasBusinessMembership(claims: BizClaims): boolean {
  const biz = claims.biz;
  const hasBiz = !!biz && typeof biz === "object" && Object.keys(biz).length > 0;
  return hasBiz || claims.biz_overflow === true;
}

export async function middleware(request: NextRequest) {
  const { response, user, claims } = await updateSession(request);
  const { pathname } = request.nextUrl;

  const isOnboardingRoute =
    pathname.startsWith("/onboarding") || pathname.startsWith("/business/onboarding");

  // Business portal routes require both a user and membership claims.
  // The exact marketing page `/business` and `/business/onboarding` are
  // excluded here so they can be handled by the onboarding rule above (or,
  // for `/business` itself, stay fully public).
  const isBusinessPortalRoute =
    pathname.startsWith("/business/") && !pathname.startsWith("/business/onboarding");

  if ((isOnboardingRoute || isBusinessPortalRoute) && !user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isBusinessPortalRoute && user && !hasBusinessMembership(claims)) {
    return NextResponse.redirect(new URL("/business/onboarding", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon|brand/).*)"],
};
