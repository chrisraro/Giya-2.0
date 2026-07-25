import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SERVER_ENV = {
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "a".repeat(20),
  REDEMPTION_TOKEN_SECRET: "a".repeat(32),
};

vi.mock("./env", () => ({
  getServerEnv: () => SERVER_ENV,
}));

describe("redisKey", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("namespaces parts by NODE_ENV", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const { redisKey } = await import("./redis");

    expect(redisKey("redeem", "jti", "abc123")).toBe("test:redeem:jti:abc123");
  });
});

describe("setNx", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sends the exact SET NX EX command payload and returns true on OK", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: "OK" }),
    });

    const { setNx } = await import("./redis");
    const result = await setNx("k1", "v1", 300);

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SERVER_ENV.UPSTASH_REDIS_REST_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${SERVER_ENV.UPSTASH_REDIS_REST_TOKEN}`,
    });
    expect(JSON.parse(init.body as string)).toEqual([
      "SET",
      "k1",
      "v1",
      "NX",
      "EX",
      "300",
    ]);
  });

  it("returns false when the key already exists (result null)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: null }),
    });

    const { setNx } = await import("./redis");
    const result = await setNx("k1", "v1", 300);

    expect(result).toBe(false);
  });

  it("throws on a non-200 response (fail closed, never silently succeed)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
      text: async () => "boom",
    });

    const { setNx } = await import("./redis");

    await expect(setNx("k1", "v1", 300)).rejects.toThrow();
  });
});

describe("getDel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sends the exact GETDEL command payload and returns the value", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: "claim-123" }),
    });

    const { getDel } = await import("./redis");
    const result = await getDel("k1");

    expect(result).toBe("claim-123");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SERVER_ENV.UPSTASH_REDIS_REST_URL);
    expect(JSON.parse(init.body as string)).toEqual(["GETDEL", "k1"]);
  });

  it("returns null when the key is absent (already consumed or never set)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: null }),
    });

    const { getDel } = await import("./redis");
    const result = await getDel("k1");

    expect(result).toBeNull();
  });

  it("issues a single call, never GET followed by DEL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: "claim-123" }),
    });

    const { getDel } = await import("./redis");
    await getDel("k1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-200 response (fail closed, must not permit replay)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
      text: async () => "boom",
    });

    const { getDel } = await import("./redis");

    await expect(getDel("k1")).rejects.toThrow();
  });
});
