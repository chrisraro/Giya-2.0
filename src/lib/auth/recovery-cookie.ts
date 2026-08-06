// Shared between src/app/auth/confirm/route.ts (which sets this cookie,
// and only after a genuine, explicit `verifyOtp({ type: "recovery" })`
// success - never inferred from a session's `amr` claim, which cannot
// distinguish a recovery link from a magic-link sign-in or any other
// email-OTP flow; they all record as `amr: "otp"`) and
// src/app/auth/recovery-status/route.ts (which reads it, since
// reset-password/page.tsx is a Client Component and cannot read an
// httpOnly cookie itself). This cookie IS the recovery gate: an
// already-signed-in session, of any kind, never carries it.
export const RECOVERY_COOKIE_NAME = "sb-recovery-verified";

// A TTL, not single-use-then-delete-on-READ: deleting it on the first read
// would log a user out of their own password reset the moment they reload
// the page or the moment recovery-status is polled a second time, for no
// security benefit over a short expiry. That reasoning does NOT extend to
// delete-on-SUCCESS, which has no such cost: see clearRecoveryCookieHeader
// below, called by src/app/api/v1/auth/reset-password/route.ts once
// updateUser actually succeeds. Without it, the window between "password
// changed" and "cookie expires" leaves the marker minted by /auth/confirm
// still valid: sign in normally with the new password, navigate back to
// /reset-password, and recovery-status still answers true for up to ten
// minutes - the marker admitting an ORDINARY session is exactly the
// property this whole design exists to prevent, just bounded in time
// instead of unbounded. Ten minutes is generous for "read the email, click
// the link, type a new password" without leaving a stale marker around for
// long after a reset that never completes.
export const RECOVERY_COOKIE_MAX_AGE_SECONDS = 600;

// The Set-Cookie value that deletes the cookie: Max-Age=0 tells the browser
// to expire it immediately. Every other attribute (Path, HttpOnly, Secure,
// SameSite) must match what /auth/confirm/route.ts set when it minted the
// cookie via NextResponse.cookies.set(...) - a clearing Set-Cookie with a
// different Path or SameSite targets a different cookie as far as the
// browser is concerned, and would silently fail to remove the real one.
// Exported as a raw header string, not a NextResponse.cookies.delete()
// call, because src/app/api/v1/auth/reset-password/route.ts is built with
// defineHandler and can only add response headers through its
// HandlerResult contract - it never gets a NextResponse object of its own
// to call .cookies on directly.
export function clearRecoveryCookieHeader(): string {
  return `${RECOVERY_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
