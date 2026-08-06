import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getHealth(): the aggregate behind GET /api/v1/health (doc 52's synthetic
// uptime probe target). Every check below goes through an injected
// `fetchImpl` rather than the real network - this module talks to Postgres
// (PostgREST), Redis (Upstash REST) and QStash entirely over `fetch`, the
// same "no SDK, plain REST" shape as src/lib/redis.ts and
// src/lib/queue/publish.ts.
//
// The leak test at the bottom is the one that matters most (t2-3-brief.md):
// a health check is the one endpoint EVERY unauthenticated caller and every
// external uptime monitor can reach, so nothing it reports may ever let a
// dependency failure's raw text (a connection string, a key fragment, a
// driver's error message) reach the response body.

vi.mock("server-only", () => ({}));

const SUPABASE_URL = "https://example.supabase.co";
const ANON_KEY = "sb_publishable_abcdefghijklmnopqrstuvwxyz";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  },
}));

const { checkDatabase, checkRedis, checkQueue, getHealth } = await import("./health");

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("checkDatabase", () => {
  it("reports ok with an integer latency when PostgREST answers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ id: "1" }]));

    const result = await checkDatabase({ fetchImpl, timeoutMs: 1000 });

    expect(result.status).toBe("ok");
    expect(Number.isInteger(result.latencyMs)).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("calls PostgREST with the anon key, never a service-role credential", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));

    await checkDatabase({ fetchImpl, timeoutMs: 1000 });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(SUPABASE_URL);
    expect((init.headers as Record<string, string>).apikey).toBe(ANON_KEY);
  });

  it("reports down when the request throws (network refused, DNS failure, timeout)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));

    const result = await checkDatabase({ fetchImpl, timeoutMs: 1000 });

    expect(result.status).toBe("down");
  });

  it("reports degraded, not down, when PostgREST answers but with a non-2xx status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "boom" }, false, 500));

    const result = await checkDatabase({ fetchImpl, timeoutMs: 1000 });

    expect(result.status).toBe("degraded");
  });
});

describe("checkRedis", () => {
  it("reports ok when Upstash answers PONG", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ result: "PONG" }));

    const result = await checkRedis({ fetchImpl, timeoutMs: 1000 });

    expect(result.status).toBe("ok");
  });

  it("reports down when Redis is unreachable", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    const fetchImpl = vi.fn().mockRejectedValue(new Error("fetch failed"));

    const result = await checkRedis({ fetchImpl, timeoutMs: 1000 });

    expect(result.status).toBe("down");
  });

  it("reports down when the credentials are not configured at all", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    const fetchImpl = vi.fn();

    const result = await checkRedis({ fetchImpl, timeoutMs: 1000 });

    expect(result.status).toBe("down");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("checkQueue", () => {
  it("returns null (omitted) when QStash is not configured", async () => {
    vi.stubEnv("QSTASH_URL", "");
    vi.stubEnv("QSTASH_TOKEN", "");
    const fetchImpl = vi.fn();

    const result = await checkQueue({ fetchImpl, timeoutMs: 1000 });

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports ok when QStash is configured and reachable", async () => {
    vi.stubEnv("QSTASH_URL", "https://qstash-us-east-1.upstash.io");
    vi.stubEnv("QSTASH_TOKEN", "a".repeat(20));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));

    const result = await checkQueue({ fetchImpl, timeoutMs: 1000 });

    expect(result?.status).toBe("ok");
  });

  it("reports down when QStash is configured but unreachable", async () => {
    vi.stubEnv("QSTASH_URL", "https://qstash-us-east-1.upstash.io");
    vi.stubEnv("QSTASH_TOKEN", "a".repeat(20));
    const fetchImpl = vi.fn().mockRejectedValue(new Error("timeout"));

    const result = await checkQueue({ fetchImpl, timeoutMs: 1000 });

    expect(result?.status).toBe("down");
  });
});

describe("getHealth", () => {
  function allUpFetch(): typeof fetch {
    return vi.fn(async (url: string) => {
      if (url.includes("upstash.io") && url.includes("qstash")) return jsonResponse([]);
      if (url.includes("upstash.io")) return jsonResponse({ result: "PONG" });
      return jsonResponse([{ id: "1" }]);
    }) as unknown as typeof fetch;
  }

  it("answers 200 with an ok status per dependency when everything is up", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    vi.stubEnv("QSTASH_URL", "");
    vi.stubEnv("QSTASH_TOKEN", "");

    const result = await getHealth({ fetchImpl: allUpFetch(), timeoutMs: 1000 });

    expect(result.httpStatus).toBe(200);
    expect(result.dependencies.database?.status).toBe("ok");
    expect(result.dependencies.redis?.status).toBe("ok");
    expect(result.dependencies.queue).toBeUndefined();
  });

  it("answers 503 when the database is down", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    vi.stubEnv("QSTASH_URL", "");
    vi.stubEnv("QSTASH_TOKEN", "");

    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("upstash.io")) return jsonResponse({ result: "PONG" });
      throw new Error("connect ETIMEDOUT");
    });

    const result = await getHealth({ fetchImpl, timeoutMs: 1000 });

    expect(result.httpStatus).toBe(503);
    expect(result.dependencies.database?.status).toBe("down");
  });

  it("reflects a down Redis in its own status and in the overall 503", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    vi.stubEnv("QSTASH_URL", "");
    vi.stubEnv("QSTASH_TOKEN", "");

    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("upstash.io")) throw new Error("connect ECONNREFUSED");
      return jsonResponse([{ id: "1" }]);
    });

    const result = await getHealth({ fetchImpl, timeoutMs: 1000 });

    expect(result.dependencies.redis?.status).toBe("down");
    expect(result.httpStatus).toBe(503);
  });

  it("includes the queue only when QStash is configured, and a down queue also flips the overall status", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    vi.stubEnv("QSTASH_URL", "https://qstash-us-east-1.upstash.io");
    vi.stubEnv("QSTASH_TOKEN", "a".repeat(20));

    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("qstash")) throw new Error("connect ECONNREFUSED");
      if (url.includes("upstash.io")) return jsonResponse({ result: "PONG" });
      return jsonResponse([{ id: "1" }]);
    });

    const result = await getHealth({ fetchImpl, timeoutMs: 1000 });

    expect(result.dependencies.queue?.status).toBe("down");
    expect(result.httpStatus).toBe(503);
  });

  it("reports every dependency status as one of ok/degraded/down and every latency as a non-negative integer", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    vi.stubEnv("QSTASH_URL", "https://qstash-us-east-1.upstash.io");
    vi.stubEnv("QSTASH_TOKEN", "a".repeat(20));

    const result = await getHealth({ fetchImpl: allUpFetch(), timeoutMs: 1000 });

    for (const check of Object.values(result.dependencies)) {
      expect(["ok", "degraded", "down"]).toContain(check.status);
      expect(Number.isInteger(check.latencyMs)).toBe(true);
      expect(check.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  // -------------------------------------------------------------------------
  // THE LEAK TEST. See t2-3-brief.md: "Leaks nothing: no connection strings,
  // no key fragments, no schema names, no version numbers of upstream
  // services, no error text from the driver." This is checked against every
  // failure mode at once, and against the raw serialized response body, not
  // against a hand-picked field - a leak in a field this test does not know
  // to check is still a leak.
  // -------------------------------------------------------------------------
  it("never lets a dependency's raw error text, a credential or a connection string reach the body", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    vi.stubEnv("QSTASH_URL", "https://qstash-us-east-1.upstash.io");
    vi.stubEnv("QSTASH_TOKEN", "a".repeat(20));

    const secrets = [
      ANON_KEY,
      "a".repeat(20), // the stubbed redis/qstash token
      "postgres://giya:sup3rSecretPass@db.internal:5432/giya",
      "ECONNREFUSED",
      "ETIMEDOUT",
      SUPABASE_URL,
      "PGRST116",
      "23505",
    ];

    const fetchImpl = vi.fn().mockRejectedValue(
      new Error(
        "connect ECONNREFUSED postgres://giya:sup3rSecretPass@db.internal:5432/giya (PGRST116, code 23505) ETIMEDOUT",
      ),
    );

    const result = await getHealth({ fetchImpl, timeoutMs: 1000 });
    const serialized = JSON.stringify(result);

    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }

    // The shape itself is closed: only status and latencyMs per dependency,
    // nothing else can carry a leak through later either.
    for (const check of Object.values(result.dependencies)) {
      expect(Object.keys(check).sort()).toEqual(["latencyMs", "status"]);
    }
  });
});
