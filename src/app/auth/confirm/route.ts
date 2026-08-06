import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { RECOVERY_COOKIE_NAME, RECOVERY_COOKIE_MAX_AGE_SECONDS } from "@/lib/auth/recovery-cookie";

// GET /auth/confirm - completes a password-recovery email link via
// Supabase's token_hash + verifyOtp pattern
// (https://supabase.com/docs/guides/auth/server-side/email-based-auth-with-pkce-flow),
// NOT the PKCE code-exchange flow /auth/callback uses for signup
// confirmation and OAuth. Two reasons this had to be a different mechanism
// for recovery specifically, not just a different route doing the same
// thing:
//
//   1. Explicitness. A PKCE-exchanged session's `amr` claim cannot tell a
//      recovery link apart from a magic-link sign-in, an invite, or a
//      signup confirmation - GoTrue records all of them as `amr: "otp"`.
//      reset-password/page.tsx used to guess from that claim and was
//      always going to be wrong for exactly this reason. Here, `type`
//      arrives as an explicit, literal query parameter and is passed
//      straight to `verifyOtp({ type, token_hash })` - nothing is
//      inferred after the fact.
//   2. Device independence. A PKCE code exchange needs the code_verifier
//      that was written to the INITIATING browser's storage, so the link
//      only works back on that same browser/device - including the
//      common case of an email opened in Gmail/Outlook/Facebook's in-app
//      browser, which is a different storage context on the same phone.
//      verifyOtp needs only the token_hash from the URL itself, checked
//      against what Supabase stored server-side, so it works from any
//      device or browser that opens the link.
//
// This route deliberately handles ONLY `type=recovery` - it is not a
// general-purpose "verify any EmailOtpType" handler. Accepting `signup`,
// `invite`, `magiclink`, or `email_change` here too would mint the exact
// cookie reset-password's gate trusts for any of them, which would let
// (for example) a magic-link sign-in reach the set-a-new-password form -
// precisely the over-permissive gate this design exists to close.
//
// DEPLOYMENT DEPENDENCY, not something this file can satisfy on its own:
// Supabase's DEFAULT recovery email template links via `{{ .ConfirmationURL }}`,
// which is the PKCE code flow this route does NOT handle. For this route to
// ever receive traffic, the Recovery email template in the Supabase
// Dashboard (Authentication > Email Templates - not a file in this repo)
// must be changed to link to
// `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`
// instead. See the report for T3.1 for the full note; this is an ops
// action item this sandboxed environment has no access to perform.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  if (tokenHash && type === "recovery") {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
    if (!error) {
      const response = NextResponse.redirect(`${origin}/reset-password`);
      response.cookies.set(RECOVERY_COOKIE_NAME, "1", {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: RECOVERY_COOKIE_MAX_AGE_SECONDS,
        path: "/",
      });
      return response;
    }
  }

  // Same notice /auth/callback uses for its own dead-code-exchange case,
  // and the same one login/page.tsx already knows how to render ("That
  // link expired or was already used. Sign in or request a new one.") -
  // deliberately generic across "missing token_hash", "wrong type", and
  // "verifyOtp rejected it" so none of those cases becomes its own oracle.
  return NextResponse.redirect(`${origin}/login?error=confirm`);
}
