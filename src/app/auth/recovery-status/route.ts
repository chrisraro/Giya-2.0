import { NextResponse, type NextRequest } from "next/server";

import { RECOVERY_COOKIE_NAME } from "@/lib/auth/recovery-cookie";

// GET /auth/recovery-status - the one bridge between the httpOnly cookie
// /auth/confirm sets and reset-password/page.tsx, which is a Client
// Component and therefore cannot read that cookie directly (that is the
// point of it being httpOnly: client JS, including a compromised
// dependency, cannot forge it). This route reads it server-side and
// answers with nothing more than a boolean - never the cookie's raw value,
// never anything else about the request.
export async function GET(request: NextRequest) {
  const verified = request.cookies.get(RECOVERY_COOKIE_NAME)?.value === "1";

  return NextResponse.json(
    { data: { verified } },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
