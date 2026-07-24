import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { getSafeRedirect } from "@/lib/auth/safe-redirect";

// Completes the Supabase PKCE email-confirmation / OAuth handshake: swaps
// the one-time `code` for a session (which writes the auth cookies via the
// server client's setAll), then redirects to a validated internal `next`
// path. Any failure (missing code, exchange error) sends the user back to
// /login with a notice rather than leaking the raw error or, worse,
// honoring an unvalidated `next` as an open redirect.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = getSafeRedirect(searchParams.get("next"), "/home");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=confirm`);
}
