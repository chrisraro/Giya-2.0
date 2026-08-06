import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Doc 13 error envelope + doc 30 section 2.8: BUSINESS_SUSPENDED (raised by
// service.validateRedemption's suspension gate) must reach the client as a
// 403 with the registered code, not fall through to a generic 500 - this is
// the "surfaced through the existing error envelope" half of the brief's
// requirement 4.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  validateRedemption: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
  })),
}));

vi.mock("@/features/rewards/server/service", () => ({
  validateRedemption: mocks.validateRedemption,
}));

const { POST } = await import("./route");

const USER_ID = "11111111-1111-4111-8111-111111111111";

function mockAuthed() {
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
}

async function callRoute(body: unknown = { token: "signed.jwt.token" }) {
  const request = new NextRequest("http://localhost/api/v1/redemptions/validate", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return POST(request);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthed();
});

describe("POST /api/v1/redemptions/validate - suspension envelope", () => {
  it("CRITICAL: maps BUSINESS_SUSPENDED to 403 with the registered code, not a generic 500", async () => {
    mocks.validateRedemption.mockResolvedValue({
      ok: false,
      code: "BUSINESS_SUSPENDED",
      message: "Redemptions are paused for this business account.",
    });

    const response = await callRoute();
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.error.code).toBe("BUSINESS_SUSPENDED");
  });

  it("maps DEPENDENCY_UNAVAILABLE to 503 (the suspension read-failure case)", async () => {
    mocks.validateRedemption.mockResolvedValue({
      ok: false,
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Something went wrong. Please try again.",
    });

    const response = await callRoute();

    expect(response.status).toBe(503);
  });

  it("still returns 200 for a successful, unsuspended redemption (the negative case)", async () => {
    mocks.validateRedemption.mockResolvedValue({
      ok: true,
      data: {
        claimId: "claim-1",
        rewardName: "Free Coffee",
        consumerName: "Juan",
        redeemedAt: "2026-07-25T12:00:00.000Z",
      },
    });

    const response = await callRoute();

    expect(response.status).toBe(200);
  });
});
