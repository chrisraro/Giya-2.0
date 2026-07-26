import { beforeEach, describe, expect, it, vi } from "vitest";

// The Nominatim client. These tests are about the USAGE POLICY as much as the
// parsing: the descriptive User-Agent, the global (not per-caller) one request
// per second, and the caching the policy asks for. Those are the reasons this
// module exists on the server at all - see its header.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
  get: mocks.get,
  set: mocks.set,
}));

const { reverseGeocode, searchAddress } = await import("./geocode");

const fetchMock = vi.fn();

function respondWith(body: unknown, status = 200) {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function lastRequest(): { url: URL; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return { url: new URL(String(call[0])), init: (call[1] ?? {}) as RequestInit };
}

const CEBU_PLACE = {
  place_id: 12345,
  lat: "10.3156",
  lon: "123.8854",
  display_name: "12 Real Street, San Jose, Cebu City, Philippines",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  mocks.checkRateLimit.mockResolvedValue({ ok: true, remaining: 0, resetSeconds: 1 });
  mocks.get.mockResolvedValue(null);
  mocks.set.mockResolvedValue(undefined);
});

// ===================================================== the usage policy

describe("the Nominatim usage policy", () => {
  it("identifies the application in a User-Agent, which is why this is not in the browser", async () => {
    respondWith([CEBU_PLACE]);

    await searchAddress("12 Real Street Cebu");

    const header = (lastRequest().init.headers as Record<string, string>)["User-Agent"];
    // `User-Agent` is a forbidden header name in the Fetch standard, so browser
    // code cannot set it and cannot comply. The whole server proxy exists for
    // this one line.
    expect(header).toContain("Giya");
    // The policy treats a generic string as unidentified: it wants contact
    // details it can actually use.
    expect(header).toMatch(/https?:\/\//);
    expect(header).toContain("@");
  });

  it("claims the one-per-second budget on a GLOBAL key, not a per-caller one", async () => {
    respondWith([CEBU_PLACE]);

    await searchAddress("12 Real Street Cebu");

    // The policy limits the APPLICATION. A limiter keyed by user would multiply
    // the ceiling by however many merchants happen to be online.
    expect(mocks.checkRateLimit).toHaveBeenCalledWith({
      key: "test:nominatim:global",
      limit: 1,
      windowSeconds: 1,
    });
  });

  it("declines rather than calling Nominatim when the budget is spent", async () => {
    mocks.checkRateLimit.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 1 });

    const outcome = await searchAddress("12 Real Street Cebu");

    expect(outcome).toEqual({ ok: false, reason: "throttled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches results, which the policy asks for and addresses make easy", async () => {
    respondWith([CEBU_PLACE]);

    await searchAddress("12 Real Street Cebu");

    expect(mocks.set).toHaveBeenCalledWith(
      "test:geo:search:12 real street cebu",
      expect.any(String),
      86_400,
    );
  });

  it("serves a cached search without spending a request or a budget claim", async () => {
    mocks.get.mockResolvedValue(
      JSON.stringify([{ id: "1", label: "Cached place", lat: 10.3, lng: 123.9 }]),
    );

    const outcome = await searchAddress("12 Real Street Cebu");

    expect(outcome).toEqual({ ok: true, data: [{ id: "1", label: "Cached place", lat: 10.3, lng: 123.9 }] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it("biases results to the market rather than geocoding the whole planet", async () => {
    respondWith([CEBU_PLACE]);

    await searchAddress("12 Real Street");

    expect(lastRequest().url.searchParams.get("countrycodes")).toBe("ph");
  });

  it("asks for a bounded number of results", async () => {
    respondWith([CEBU_PLACE]);

    await searchAddress("Real Street");

    expect(Number(lastRequest().url.searchParams.get("limit"))).toBeLessThanOrEqual(5);
  });
});

// ============================================================== searching

describe("searchAddress", () => {
  it("reduces a place to the four fields the picker needs", async () => {
    respondWith([CEBU_PLACE]);

    const outcome = await searchAddress("12 Real Street Cebu");

    expect(outcome).toEqual({
      ok: true,
      data: [
        {
          id: "12345",
          label: "12 Real Street, San Jose, Cebu City, Philippines",
          lat: 10.3156,
          lng: 123.8854,
        },
      ],
    });
  });

  it("returns nothing, and spends nothing, for a query too short to mean anything", async () => {
    const outcome = await searchAddress("ab");

    expect(outcome).toEqual({ ok: true, data: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it("collapses whitespace so two spellings of one query share a cache entry", async () => {
    respondWith([CEBU_PLACE]);

    await searchAddress("  12   Real    Street  ");

    expect(lastRequest().url.searchParams.get("q")).toBe("12 Real Street");
  });

  it("keeps the punctuation Philippine addresses are written with", async () => {
    respondWith([CEBU_PLACE]);

    await searchAddress("Blk 3 Lot 12, Brgy. San Jose");

    expect(lastRequest().url.searchParams.get("q")).toBe("Blk 3 Lot 12, Brgy. San Jose");
  });

  it("drops a place whose coordinates do not parse rather than surfacing a NaN pin", async () => {
    respondWith([CEBU_PLACE, { ...CEBU_PLACE, place_id: 9, lat: "not-a-number" }]);

    const outcome = await searchAddress("Real Street");

    expect(outcome.ok && outcome.data).toHaveLength(1);
  });

  it("drops a place whose coordinates are out of range", async () => {
    respondWith([{ ...CEBU_PLACE, lat: "910" }]);

    const outcome = await searchAddress("Real Street");

    expect(outcome.ok && outcome.data).toEqual([]);
  });

  it("reports unavailable on an upstream error status", async () => {
    respondWith("rate limited", 429);

    expect(await searchAddress("Real Street")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("reports unavailable rather than throwing when the network fails", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    expect(await searchAddress("Real Street")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("reports unavailable when the payload is not the shape it promised", async () => {
    respondWith({ unexpected: true });

    expect(await searchAddress("Real Street")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("treats an unreadable cache as a miss rather than an error", async () => {
    mocks.get.mockResolvedValue("{ not json");
    respondWith([CEBU_PLACE]);

    const outcome = await searchAddress("Real Street");

    expect(outcome.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("still answers when the cache write fails", async () => {
    mocks.set.mockRejectedValue(new Error("redis down"));
    respondWith([CEBU_PLACE]);

    const outcome = await searchAddress("Real Street");

    expect(outcome.ok).toBe(true);
  });
});

// =============================================================== reversing

describe("reverseGeocode", () => {
  it("returns the address at a point", async () => {
    respondWith({ display_name: "12 Real Street, Cebu City" });

    expect(await reverseGeocode({ lat: 10.3156, lng: 123.8854 })).toEqual({
      ok: true,
      data: "12 Real Street, Cebu City",
    });
  });

  it("returns null, not an error, where no address exists", async () => {
    // The middle of a field, a new subdivision. The pin is still valid and
    // still saveable; it just has no name.
    respondWith({ error: "Unable to geocode" });

    expect(await reverseGeocode({ lat: 10.3156, lng: 123.8854 })).toEqual({ ok: true, data: null });
  });

  it("keys the cache at about 11 metres, so a nudge of the pin is not a new request", async () => {
    respondWith({ display_name: "12 Real Street" });

    await reverseGeocode({ lat: 10.31561234, lng: 123.88549876 });

    expect(mocks.set).toHaveBeenCalledWith(
      "test:geo:reverse:10.3156,123.8855",
      expect.any(String),
      86_400,
    );
  });

  it("spends nothing on a coordinate that is out of range", async () => {
    expect(await reverseGeocode({ lat: 910, lng: 0 })).toEqual({ ok: true, data: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it("claims the same global budget the search does", async () => {
    mocks.checkRateLimit.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 1 });

    expect(await reverseGeocode({ lat: 10.3156, lng: 123.8854 })).toEqual({
      ok: false,
      reason: "throttled",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
