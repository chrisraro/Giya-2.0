import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { env } from "@/lib/env";

import type { Database } from "./types";

export type BizClaims = {
  biz?: Record<string, unknown> | null;
  biz_overflow?: boolean;
};

// Narrows an unknown app_metadata payload (from getClaims() or, as a
// fallback, getUser()) down to the shape our middleware cares about. The
// payload is `unknown` as far as TypeScript is concerned even though it's
// already been JWT-verified by the caller, so we guard the shape manually
// rather than casting.
export function toBizClaims(appMetadata: unknown): BizClaims {
  if (!appMetadata || typeof appMetadata !== "object") {
    return {};
  }

  const metadata = appMetadata as Record<string, unknown>;
  const claims: BizClaims = {};

  if (metadata.biz && typeof metadata.biz === "object") {
    claims.biz = metadata.biz as Record<string, unknown>;
  }

  if (typeof metadata.biz_overflow === "boolean") {
    claims.biz_overflow = metadata.biz_overflow;
  }

  return claims;
}

// Refreshes the Supabase auth session for a request and reads membership
// claims off the verified JWT. Follows the official @supabase/ssr
// middleware pattern: mirror any refreshed cookies into both the request
// and a freshly created response, use getUser() (never getSession()) since
// it revalidates against the Supabase Auth server, and return the response
// object unmodified by the caller afterward.
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // IMPORTANT: do not add any logic between createServerClient and
  // supabase.auth.getUser(). A stray return could make it very hard to
  // debug users being randomly logged out.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // No getClaims() here. It used to run a second time to read the `biz`
  // membership claims, but nothing consumes them: src/middleware.ts ignores
  // them (doc 12: claims are hints, the portal layout queries business_staff),
  // and getClaims() costs a JWKS verify or, on legacy HS256 projects, another
  // Auth server round trip on every request. Layouts that want claims call it
  // themselves. toBizClaims stays exported for those callers.
  return { response, user };
}
