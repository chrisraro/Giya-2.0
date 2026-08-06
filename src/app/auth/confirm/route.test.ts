import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/auth/recovery-cookie";

// GET /auth/confirm - the server side of the password-recovery email link,
// replacing the earlier (broken) design where reset-password/page.tsx
// tried to INFER "this session came from a recovery link" from the
// session's `amr` claim. `amr` cannot make that distinction: GoTrue
// records every email-OTP flow (recovery, invite, signup, magiclink) as
// `amr: "otp"` - there is no `"recovery"` AMRMethod. The token_hash +
// verifyOtp({ type: "recovery" }) pattern this route implements makes the
// type EXPLICIT at verification time instead: it is the literal `type`
// query param this route received and passed to Supabase, not a guess
// made after the fact from whatever the resulting session's claims
// happen to say.
//
// This route deliberately handles ONLY `type=recovery` - see the "wrong
// type" test below for why accepting other EmailOtpTypes here would
// reopen the over-permissive gate this whole design exists to close.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { verifyOtp: mocks.verifyOtp },
  })),
}));

const { GET } = await import("./route");

function callRoute(query: string): Promise<Response> {
  return GET(new NextRequest(`https://giya.test/auth/confirm${query}`));
}

function cookieHeader(response: Response): string {
  return response.headers.get("set-cookie") ?? "";
}

beforeEach(() => {
  mocks.verifyOtp.mockReset().mockResolvedValue({ data: {}, error: null });
});

describe("GET /auth/confirm", () => {
  it("verifies a recovery token_hash and redirects to /reset-password with the recovery cookie set", async () => {
    const response = await callRoute("?token_hash=abc123&type=recovery");

    expect(mocks.verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "abc123" });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://giya.test/reset-password");
    expect(cookieHeader(response)).toContain(`${RECOVERY_COOKIE_NAME}=1`);
    expect(cookieHeader(response)).toMatch(/HttpOnly/i);
    // X8: if this mints with a narrower Path (e.g. "/reset-password"),
    // GET /auth/recovery-status - a DIFFERENT path - would never receive
    // the cookie at all, and every real user would see "link expired."
    // Path=/ is what makes the cookie visible to both routes that need it.
    expect(cookieHeader(response)).toMatch(/;\s*path=\/(;|$)/i);
  });

  it("does NOT verify or set the cookie for any type other than recovery (e.g. a magic-link sign-in)", async () => {
    const response = await callRoute("?token_hash=abc123&type=magiclink");

    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("https://giya.test/login?error=confirm");
    expect(cookieHeader(response)).not.toContain(RECOVERY_COOKIE_NAME);
  });

  it("redirects to the expired-link notice without setting the cookie when verifyOtp fails", async () => {
    mocks.verifyOtp.mockResolvedValueOnce({ data: {}, error: { message: "Token has expired" } });

    const response = await callRoute("?token_hash=abc123&type=recovery");

    expect(response.headers.get("location")).toBe("https://giya.test/login?error=confirm");
    expect(cookieHeader(response)).not.toContain(RECOVERY_COOKIE_NAME);
  });

  it("redirects to the expired-link notice without calling verifyOtp when token_hash is missing", async () => {
    const response = await callRoute("?type=recovery");

    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("https://giya.test/login?error=confirm");
  });
});
