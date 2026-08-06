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

// A TTL, not single-use-then-delete: deleting it on the first read would
// log a user out of their own password reset the moment they reload the
// page or the moment recovery-status is polled a second time, for no
// security benefit over a short expiry - the underlying Supabase session
// this cookie gates access alongside already has its own lifetime, and the
// real one-time-use property (the recovery TOKEN itself) is enforced by
// Supabase, not by this cookie. Ten minutes is generous for "read the
// email, click the link, type a new password" without leaving a stale
// marker around for long.
export const RECOVERY_COOKIE_MAX_AGE_SECONDS = 600;
