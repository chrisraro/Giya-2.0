import { NextRequest } from "next/server";
import { describe, it, expect } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/auth/recovery-cookie";
import { GET } from "./route";

// GET /auth/recovery-status - lets reset-password/page.tsx (a Client
// Component; it cannot read an httpOnly cookie itself) ask whether THIS
// browser just came through /auth/confirm's verifyOtp(type: "recovery")
// check. The cookie is httpOnly specifically so client JS can never forge
// it; this route is the only legitimate way to learn its value.

function callRoute(cookieHeader?: string): Promise<Response> {
  const init = cookieHeader ? { headers: { cookie: cookieHeader } } : undefined;
  return GET(new NextRequest("https://giya.test/auth/recovery-status", init));
}

describe("GET /auth/recovery-status", () => {
  it("reports verified: true when the recovery cookie is present and set to 1", async () => {
    const response = await callRoute(`${RECOVERY_COOKIE_NAME}=1`);
    const json = (await response.json()) as { data: { verified: boolean } };

    expect(json.data.verified).toBe(true);
  });

  it("reports verified: false when the cookie is absent", async () => {
    const response = await callRoute();
    const json = (await response.json()) as { data: { verified: boolean } };

    expect(json.data.verified).toBe(false);
  });

  it("reports verified: false when a caller sends some OTHER value for the cookie (never trust the value blindly)", async () => {
    const response = await callRoute(`${RECOVERY_COOKIE_NAME}=true`);
    const json = (await response.json()) as { data: { verified: boolean } };

    expect(json.data.verified).toBe(false);
  });

  it("is never cached, since the answer is per-caller and time-sensitive", async () => {
    const response = await callRoute(`${RECOVERY_COOKIE_NAME}=1`);

    expect(response.headers.get("Cache-Control")).toMatch(/no-store/);
  });
});
