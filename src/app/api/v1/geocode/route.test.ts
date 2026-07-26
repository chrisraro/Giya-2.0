import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/v1/geocode - the server side of the merchant's location picker.
//
// The geocoder itself is mocked at its own boundary, so these tests are about
// the HTTP contract: doc 13's envelope, the session gate that keeps our
// Nominatim budget from being spent by anonymous callers, the two modes, and
// the coordinate range check that refuses nonsense before it can cost a
// request upstream.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  searchAddress: vi.fn(),
  reverseGeocode: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));

vi.mock("@/lib/maps/geocode", () => ({
  searchAddress: mocks.searchAddress,
  reverseGeocode: mocks.reverseGeocode,
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));

vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
}));

const { GET } = await import("./route");

const USER = { id: "11111111-1111-4111-8111-111111111111" };

const CEBU_RESULT = {
  id: "12345",
  label: "12 Real Street, San Jose, Cebu City",
  lat: 10.3156,
  lng: 123.8854,
};

async function callRoute(search: string): Promise<Response> {
  return GET(new NextRequest(`https://giya.test/api/v1/geocode${search}`, { method: "GET" }));
}

async function bodyOf(response: Response): Promise<Record<string, never>> {
  return (await response.json()) as Record<string, never>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: USER } });
  mocks.checkRateLimit.mockResolvedValue({ ok: true, remaining: 29, resetSeconds: 60 });
  mocks.searchAddress.mockResolvedValue({ ok: true, data: [CEBU_RESULT] });
  mocks.reverseGeocode.mockResolvedValue({ ok: true, data: "12 Real Street, Cebu City" });
});

describe("who may spend the geocoding budget", () => {
  it("refuses a caller with no session", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    const response = await callRoute("?q=Real+Street");

    expect(response.status).toBe(401);
    // Address search is a merchant setup task with no consumer use, so an
    // anonymous caller could only ever be spending our Nominatim allowance.
    expect(mocks.searchAddress).not.toHaveBeenCalled();
  });

  it("limits a signed-in caller too, separately from the global upstream ceiling", async () => {
    await callRoute("?q=Real+Street");

    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 30, windowSeconds: 60 }),
    );
  });

  it("answers 429 without calling upstream when the caller is over their limit", async () => {
    mocks.checkRateLimit.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 42 });

    const response = await callRoute("?q=Real+Street");

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(mocks.searchAddress).not.toHaveBeenCalled();
  });
});

describe("searching", () => {
  it("returns the results inside doc 13's envelope", async () => {
    const response = await callRoute("?q=12+Real+Street");
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ data: { results: [CEBU_RESULT], address: null } });
    expect(mocks.searchAddress).toHaveBeenCalledWith("12 Real Street");
  });

  it("carries a request id, so a merchant's report can be correlated", async () => {
    const response = await callRoute("?q=Real+Street");
    const body = (await response.json()) as { meta: { request_id: string } };

    expect(response.headers.get("X-Request-Id")).toBeTruthy();
    expect(body.meta.request_id).toBeTruthy();
  });

  it("is not cached by the browser: the useful cache is the 24h one upstream", async () => {
    const response = await callRoute("?q=Real+Street");

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("refuses a query too short to mean anything, before it reaches the geocoder", async () => {
    const response = await callRoute("?q=ab");

    expect(response.status).toBe(422);
    expect(mocks.searchAddress).not.toHaveBeenCalled();
  });

  it("refuses a request that names neither a query nor a coordinate pair", async () => {
    const response = await callRoute("");

    expect(response.status).toBe(422);
    expect(mocks.searchAddress).not.toHaveBeenCalled();
    expect(mocks.reverseGeocode).not.toHaveBeenCalled();
  });

  it("refuses a request that asks for both modes at once rather than guessing", async () => {
    const response = await callRoute("?q=Real+Street&lat=10.3&lng=123.8");

    expect(response.status).toBe(422);
    expect(mocks.searchAddress).not.toHaveBeenCalled();
    expect(mocks.reverseGeocode).not.toHaveBeenCalled();
  });
});

describe("reversing", () => {
  it("returns the address at a point", async () => {
    const response = await callRoute("?lat=10.3156&lng=123.8854");
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ data: { results: [], address: "12 Real Street, Cebu City" } });
  });

  it("rounds the point before spending a lookup on it", async () => {
    await callRoute("?lat=10.315612345678&lng=123.885498765");

    expect(mocks.reverseGeocode).toHaveBeenCalledWith({ lat: 10.315612, lng: 123.885499 });
  });

  it("returns a null address rather than an error where no address exists", async () => {
    mocks.reverseGeocode.mockResolvedValue({ ok: true, data: null });

    const response = await callRoute("?lat=10.3156&lng=123.8854");

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({ data: { address: null } });
  });

  it.each([
    ["a latitude out of range", "?lat=91&lng=120"],
    ["a longitude out of range", "?lat=10&lng=181"],
    ["a non-numeric latitude", "?lat=north&lng=120"],
    ["a latitude with no longitude", "?lat=10.3156"],
    ["a longitude with no latitude", "?lng=123.8854"],
  ])("refuses %s before it can cost an upstream request", async (_label, search) => {
    const response = await callRoute(search);

    expect(response.status).toBe(422);
    expect(mocks.reverseGeocode).not.toHaveBeenCalled();
  });
});

describe("when the geocoder declines", () => {
  it("passes the global one-per-second throttle through as a 429 with an honest Retry-After", async () => {
    mocks.searchAddress.mockResolvedValue({ ok: false, reason: "throttled" });

    const response = await callRoute("?q=Real+Street");
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("reports an upstream outage as 503, and says the map still works", async () => {
    mocks.searchAddress.mockResolvedValue({ ok: false, reason: "unavailable" });

    const response = await callRoute("?q=Real+Street");
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    // The message is shown to a merchant verbatim, so it has to name the way out.
    expect(body.error.message).toMatch(/drag the pin/i);
  });
});
