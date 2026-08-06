import { NextResponse, type NextRequest } from "next/server";

import { registerDevice } from "@/features/identity/server/devices";
import { createClient } from "@/lib/supabase/server";
import { getSafeRedirect } from "@/lib/auth/safe-redirect";

// Completes the Supabase PKCE email-confirmation / OAuth handshake: swaps
// the one-time `code` for a session (which writes the auth cookies via the
// server client's setAll), then redirects to a validated internal `next`
// path. Any failure (missing code, exchange error) sends the user back to
// /login with a notice rather than leaking the raw error or, worse,
// honoring an unvalidated `next` as an open redirect.
//
// WHY `next` STILL DEFAULTS TO /home:
//
// The default is for arrivals that carry no destination of their own, which
// in practice means a confirmation link opened long after signup or an OAuth
// provider round trip started somewhere that did not set one. /home is the
// right landing spot for those, and it is now SAFE for an account that never
// finished onboarding: the consumer layout gates on profiles.onboarded_at and
// forwards an un-onboarded consumer to /onboarding. Before that gate existed,
// this default was the hole people fell through - hard-coding /onboarding
// here instead would only have moved the hole, since it would then have
// re-run the wizard for everyone who had already completed it.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = getSafeRedirect(searchParams.get("next"), "/home");

  // The OAuth failure path. A provider that denies or cancels does NOT send a
  // `code`; it sends `error` / `error_description` (or, for the implicit
  // flow's fragment errors bounced back by Supabase, the same names). Without
  // this branch every one of those fell through to the generic tail below and
  // told the user their link "expired or was already used", which is a
  // confusing thing to read after tapping Cancel on a Google consent screen.
  //
  // The provider's own `error_description` is deliberately NOT forwarded: it
  // is attacker-controllable text in a query string that would end up
  // rendered on the login page. Only a fixed, known code crosses over, and
  // the login page owns the wording.
  if (searchParams.get("error")) {
    return NextResponse.redirect(`${origin}/login?error=oauth`);
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // A session now exists, so this browser is a device. `user_devices` had
      // no writer anywhere in the app until this slice; this is the PKCE and
      // OAuth half of "when a session is established" (the other is the
      // password form on /login, which registers through a server action
      // because it runs in the browser).
      //
      // ON THE SUCCESS BRANCH ONLY. A failed exchange means no session, and a
      // device row written then would be attributed to whoever was signed in
      // before.
      //
      // The catch keeps a device write from turning a WORKING sign-in into
      // "that link expired or was already used", which is what the tail of this
      // function would otherwise tell them. registerDevice already swallows its
      // own database failures; this is for the ones it cannot.
      try {
        await registerDevice();
      } catch (thrown) {
        console.error("[identity] device registration threw after code exchange", thrown);
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=confirm`);
}
