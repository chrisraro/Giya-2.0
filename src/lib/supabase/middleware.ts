import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { env } from "@/lib/env";

import type { Database } from "./types";

export type BizClaims = {
  biz?: Record<string, unknown> | null;
  biz_overflow?: boolean;
};

// Refreshes the Supabase auth session for a request and reads membership
// claims off the verified user. Follows the official @supabase/ssr
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

  const claims: BizClaims = (user?.app_metadata as BizClaims | undefined) ?? {};

  return { response, user, claims };
}
