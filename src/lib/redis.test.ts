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

describe("get", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sends the exact GET command payload and returns the value", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: "claim-123" }),
    });

    const { get } = await import("./redis");
    const result = await get("k1");

    expect(result).toBe("claim-123");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(["GET", "k1"]);
  });

  it("returns null when the key is absent", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: null }),
    });

    const { get } = await import("./redis");

    await expect(get("k1")).resolves.toBeNull();
  });

  it("throws on a non-200 response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
      text: async () => "boom",
    });

    const { get } = await import("./redis");

    await expect(get("k1")).rejects.toThrow();
  });
});

describe("set", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sends the exact SET EX command payload (unconditional, no NX) and returns true on OK", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: "OK" }),
    });

    const { set } = await import("./redis");
    const result = await set("k1", "v1", 300);

    expect(result).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(["SET", "k1", "v1", "EX", "300"]);
  });

  it("throws on a non-200 response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
      text: async () => "boom",
    });

    const { set } = await import("./redis");

    await expect(set("k1", "v1", 300)).rejects.toThrow();
  });
});

describe("del", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sends the exact DEL command payload and returns the number deleted", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 1 }),
    });

    const { del } = await import("./redis");
    const result = await del("k1");

    expect(result).toBe(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(["DEL", "k1"]);
  });

  it("returns 0 when the key did not exist", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 0 }),
    });

    const { del } = await import("./redis");

    await expect(del("k1")).resolves.toBe(0);
  });

  it("throws on a non-200 response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
      text: async () => "boom",
    });

    const { del } = await import("./redis");

    await expect(del("k1")).rejects.toThrow();
  });
});

describe("incr", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sends the exact INCR command payload and returns the new value", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 1 }),
    });

    const { incr } = await import("./redis");
    const result = await incr("k1");

    expect(result).toBe(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(["INCR", "k1"]);
  });

  it("throws on a non-200 response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
      text: async () => "boom",
    });

    const { incr } = await import("./redis");

    await expect(incr("k1")).rejects.toThrow();
  });
});

describe("incrby", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sends the exact INCRBY command payload and returns the new value", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 873 }),
    });

    const { incrby } = await import("./redis");
    const result = await incrby("k1", 873);

    expect(result).toBe(873);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(["INCRBY", "k1", "873"]);
  });

  it("truncates a fractional amount to an integer before sending it", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 10 }),
    });

    const { incrby } = await import("./redis");
    await incrby("k1", 10.9);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(["INCRBY", "k1", "10"]);
  });

  it("throws on a non-200 response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
      text: async () => "boom",
    });

    const { incrby } = await import("./redis");

    await expect(incrby("k1", 5)).rejects.toThrow();
  });
});

describe("expire", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sends the exact EXPIRE command payload and returns true when set", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 1 }),
    });

    const { expire } = await import("./redis");
    const result = await expire("k1", 60);

    expect(result).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(["EXPIRE", "k1", "60"]);
  });

  it("returns false when the key does not exist", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 0 }),
    });

    const { expire } = await import("./redis");

    await expect(expire("k1", 60)).resolves.toBe(false);
  });

  it("throws on a non-200 response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
      text: async () => "boom",
    });

    const { expire } = await import("./redis");

    await expect(expire("k1", 60)).rejects.toThrow();
  });
});

describe("expireNx", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sends the exact EXPIRE ... NX command payload and returns true when the TTL was set", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 1 }),
    });

    const { expireNx } = await import("./redis");
    const result = await expireNx("k1", 60);

    expect(result).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(["EXPIRE", "k1", "60", "NX"]);
  });

  it("returns false when the key already had a TTL (no-op)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 0 }),
    });

    const { expireNx } = await import("./redis");

    await expect(expireNx("k1", 60)).resolves.toBe(false);
  });

  it("throws on a non-200 response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
      text: async () => "boom",
    });

    const { expireNx } = await import("./redis");

    await expect(expireNx("k1", 60)).rejects.toThrow();
  });
});

describe("ttl", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sends the exact TTL command payload and returns the remaining seconds", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 42 }),
    });

    const { ttl } = await import("./redis");
    const result = await ttl("k1");

    expect(result).toBe(42);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(["TTL", "k1"]);
  });

  it("returns -1 when the key has no expiry and -2 when it does not exist, unmodified", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: -1 }),
    });
    const { ttl } = await import("./redis");
    await expect(ttl("k1")).resolves.toBe(-1);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: -2 }),
    });
    await expect(ttl("k1")).resolves.toBe(-2);
  });

  it("throws on a non-200 response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
      text: async () => "boom",
    });

    const { ttl } = await import("./redis");

    await expect(ttl("k1")).rejects.toThrow();
  });
});

describe("setGet", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sends the exact SET EX GET command payload and returns the previous value", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: "old-jti" }),
    });

    const { setGet } = await import("./redis");
    const result = await setGet("k1", "new-jti", 300);

    expect(result).toBe("old-jti");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual([
      "SET",
      "k1",
      "new-jti",
      "EX",
      "300",
      "GET",
    ]);
  });

  it("returns null when the key did not exist before (no previous value)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: null }),
    });

    const { setGet } = await import("./redis");

    await expect(setGet("k1", "new-jti", 300)).resolves.toBeNull();
  });

  it("issues a single call, never GET followed by SET", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: null }),
    });

    const { setGet } = await import("./redis");
    await setGet("k1", "new-jti", 300);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-200 response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
      text: async () => "boom",
    });

    const { setGet } = await import("./redis");

    await expect(setGet("k1", "new-jti", 300)).rejects.toThrow();
  });
});
