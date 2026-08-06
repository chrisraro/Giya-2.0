import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getHealth(): the aggregate behind GET /api/v1/health (doc 52's synthetic
// uptime probe target). Every check below goes through an injected
// `fetchImpl` rather than the real network - this module talks to Postgres
// (PostgREST) and Redis (Upstash REST) entirely over `fetch`, the same "no
// SDK, plain REST" shape as src/lib/redis.ts, and asks
// src/lib/queue/publish.ts's own `isQueueConfigured()` whether QStash is
// configured at all rather than re-deriving that predicate.
//
// The leak tests are the ones that matter most (t2-3-brief.md): a health
// check is the one endpoint EVERY unauthenticated caller and every external
// uptime monitor can reach, so nothing it reports may ever let a dependency
// failure's raw text (a connection string, a key fragment, a driver's error
// message) reach the response body - including on the non-2xx HTTP branch,
// which a THROWN-error-only leak test cannot exercise at all.

vi.mock("server-only", () => ({}));

const SUPABASE_URL = "https://example.supabase.co";
const ANON_KEY = "sb_publishable_abcdefghijklmnopqrstuvwxyz";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  },
}));

const mocks = vi.hoisted(() => ({ isQueueConfigured: vi.fn() }));
vi.mock("@/lib/queue/publish", () => ({ isQueueConfigured: mocks.isQueueConfigured }));

const { checkDatabase, checkRedis, checkQueue, getHealth } = await import("./health");

function jsonResponse(body: unknown, ok = true, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  mocks.isQueueConfigured.mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("checkDatabase", () => {
  it("reports ok with an integer latency when PostgREST answers with an array", async () => {
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

  // I2: a hard dependency answering with a non-2xx status (paused project,
  // pooler exhausted, anon key revoked) cannot serve requests, and a
  // synthetic monitor whose job is to page on exactly that state must not
  // see "degraded" (which never flips the overall 200/503).
  it("reports down, not degraded, when PostgREST answers with a non-2xx status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "boom" }, false, 500));

    const result = await checkDatabase({ fetchImpl, timeoutMs: 1000 });

    expect(result.status).toBe("down");
  });

  it("reports down on a 401/403 (anon key revoked or rotated)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "JWT invalid" }, false, 401));

    const result = await checkDatabase({ fetchImpl, timeoutMs: 1000 });

    expect(result.status).toBe("down");
  });

  it("reports degraded (reachable, unexpected answer) on a 2xx whose body is not the expected array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ unexpected: true }, true, 200));

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

  // I2
  it("reports down, not degraded, when the token is revoked (a non-2xx status)", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "Unauthorized" }, false, 401));

    const result = await checkRedis({ fetchImpl, timeoutMs: 1000 });

    expect(result.status).toBe("down");
  });

  it("reports degraded on a 2xx whose body does not carry PONG", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ result: "unexpected" }));

    const result = await checkRedis({ fetchImpl, timeoutMs: 1000 });

    expect(result.status).toBe("degraded");
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
  it("returns null (omitted) when isQueueConfigured() says the queue is not configured", async () => {
    mocks.isQueueConfigured.mockReturnValue(false);
    vi.stubEnv("QSTASH_URL", "https://qstash-us-east-1.upstash.io");
    vi.stubEnv("QSTASH_TOKEN", "a".repeat(20));
    const fetchImpl = vi.fn();

    const result = await checkQueue({ fetchImpl, timeoutMs: 1000 });

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // I4: isQueueConfigured() (src/lib/queue/publish.ts) also requires
  // QSTASH_CALLBACK_ORIGIN. A deployment with URL+TOKEN but no callback
  // origin has every enqueue() silently skip publishing - this check must
  // agree with that and treat the queue as unconfigured too, never probe it
  // directly off URL+TOKEN presence alone.
  it("defers entirely to isQueueConfigured(), never re-deriving 'configured' from URL+TOKEN alone", async () => {
    mocks.isQueueConfigured.mockReturnValue(false);
    // URL and TOKEN are BOTH set, simulating a deployment missing only
    // QSTASH_CALLBACK_ORIGIN - isQueueConfigured() would say false for this
    // exact case in production, and this check must match it.
    vi.stubEnv("QSTASH_URL", "https://qstash-us-east-1.upstash.io");
    vi.stubEnv("QSTASH_TOKEN", "a".repeat(20));
    const fetchImpl = vi.fn();

    const result = await checkQueue({ fetchImpl, timeoutMs: 1000 });

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports ok when QStash is configured and reachable", async () => {
    mocks.isQueueConfigured.mockReturnValue(true);
    vi.stubEnv("QSTASH_URL", "https://qstash-us-east-1.upstash.io");
    vi.stubEnv("QSTASH_TOKEN", "a".repeat(20));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));

    const result = await checkQueue({ fetchImpl, timeoutMs: 1000 });

    expect(result?.status).toBe("ok");
  });

  it("reports down when QStash is configured but the request throws", async () => {
    mocks.isQueueConfigured.mockReturnValue(true);
    vi.stubEnv("QSTASH_URL", "https://qstash-us-east-1.upstash.io");
    vi.stubEnv("QSTASH_TOKEN", "a".repeat(20));
    const fetchImpl = vi.fn().mockRejectedValue(new Error("timeout"));

    const result = await checkQueue({ fetchImpl, timeoutMs: 1000 });

    expect(result?.status).toBe("down");
  });

  // I2
  it("reports down, not degraded, on a non-2xx status (revoked token, QStash outage)", async () => {
    mocks.isQueueConfigured.mockReturnValue(true);
    vi.stubEnv("QSTASH_URL", "https://qstash-us-east-1.upstash.io");
    vi.stubEnv("QSTASH_TOKEN", "a".repeat(20));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "unauthorized" }, false, 401));

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
    mocks.isQueueConfigured.mockReturnValue(false);

    const result = await getHealth({ fetchImpl: allUpFetch(), timeoutMs: 1000 });

    expect(result.httpStatus).toBe(200);
    expect(result.dependencies.database?.status).toBe("ok");
    expect(result.dependencies.redis?.status).toBe("ok");
    expect(result.dependencies.queue).toBeUndefined();
  });

  it("answers 503 when the database is down", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    mocks.isQueueConfigured.mockReturnValue(false);

    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("upstash.io")) return jsonResponse({ result: "PONG" });
      throw new Error("connect ETIMEDOUT");
    });

    const result = await getHealth({ fetchImpl, timeoutMs: 1000 });

    expect(result.httpStatus).toBe(503);
    expect(result.dependencies.database?.status).toBe("down");
  });

  it("answers 503 when the database answers with a non-2xx status (paused project, pooler exhausted)", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    mocks.isQueueConfigured.mockReturnValue(false);

    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("upstash.io")) return jsonResponse({ result: "PONG" });
      return jsonResponse({ code: "PGRST301" }, false, 503);
    });

    const result = await getHealth({ fetchImpl, timeoutMs: 1000 });

    expect(result.httpStatus).toBe(503);
    expect(result.dependencies.database?.status).toBe("down");
  });

  it("reflects a down Redis in its own status and in the overall 503", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    mocks.isQueueConfigured.mockReturnValue(false);

    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("upstash.io")) throw new Error("connect ECONNREFUSED");
      return jsonResponse([{ id: "1" }]);
    });

    const result = await getHealth({ fetchImpl, timeoutMs: 1000 });

    expect(result.dependencies.redis?.status).toBe("down");
    expect(result.httpStatus).toBe(503);
  });

  it("includes the queue only when isQueueConfigured() is true, and a down queue also flips the overall status", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    vi.stubEnv("QSTASH_URL", "https://qstash-us-east-1.upstash.io");
    vi.stubEnv("QSTASH_TOKEN", "a".repeat(20));
    mocks.isQueueConfigured.mockReturnValue(true);

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
    mocks.isQueueConfigured.mockReturnValue(true);

    const result = await getHealth({ fetchImpl: allUpFetch(), timeoutMs: 1000 });

    for (const check of Object.values(result.dependencies)) {
      expect(["ok", "degraded", "down"]).toContain(check.status);
      expect(Number.isInteger(check.latencyMs)).toBe(true);
      expect(check.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  // -------------------------------------------------------------------------
  // THE LEAK TESTS. See t2-3-brief.md: "Leaks nothing: no connection strings,
  // no key fragments, no schema names, no version numbers of upstream
  // services, no error text from the driver." Checked against every failure
  // mode at once, and against the raw serialized response, not a hand-picked
  // field - a leak in a field these tests do not know to check is still a
  // leak.
  // -------------------------------------------------------------------------
  it("never lets a THROWN error's raw text, a credential or a connection string reach the body", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    vi.stubEnv("QSTASH_URL", "https://qstash-us-east-1.upstash.io");
    vi.stubEnv("QSTASH_TOKEN", "a".repeat(20));
    mocks.isQueueConfigured.mockReturnValue(true);

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

    for (const check of Object.values(result.dependencies)) {
      expect(Object.keys(check).sort()).toEqual(["latencyMs", "status"]);
    }
  });

  // I3: every dependency above was exercised only via a THROWN fetch, which
  // never reaches the `!response.ok` branch inside each probe - a mutation
  // that added response detail (`url -> status + body`) on exactly that
  // branch passed all of the tests above, including the previous version of
  // this one. This test drives each dependency through a REAL non-2xx HTTP
  // response carrying realistic upstream bodies and headers (a PostgREST
  // error object naming a schema/relation, an Upstash "Unauthorized" body, a
  // `Server`/`sb-` style header), and checks the same closed-shape and
  // no-substring guarantees against THAT branch specifically. It also
  // doubles as I2's regression pin: before that fix, every one of these
  // non-2xx responses classified as "degraded", which never flips the
  // overall 200/503 - a synthetic monitor whose entire job is to page on
  // these exact states would have stayed green throughout.
  it("never lets a non-2xx dependency response's body or headers reach the result, and reports it down", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
    vi.stubEnv("QSTASH_URL", "https://qstash-us-east-1.upstash.io");
    vi.stubEnv("QSTASH_TOKEN", "a".repeat(20));
    mocks.isQueueConfigured.mockReturnValue(true);

    const postgrestErrorBody = {
      code: "PGRST301",
      message: 'JWT expired for role "authenticated" on schema "receipts_private"',
      hint: "relation \"receipts_private.audit_logs\" access denied",
      details: null,
    };
    const upstashErrorBody = { error: "Unauthorized" };
    const leakySecrets = [
      "PGRST301",
      "receipts_private",
      "audit_logs",
      "authenticated",
      "Unauthorized",
      "sb-gateway-1a2b3c",
      "PostgREST/12.2.0",
    ];
    const leakyHeaders = { server: "PostgREST/12.2.0", "x-sb-gateway-version": "sb-gateway-1a2b3c" };

    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("qstash")) {
        return jsonResponse(upstashErrorBody, false, 401, leakyHeaders);
      }
      if (url.includes("upstash.io")) {
        return jsonResponse(upstashErrorBody, false, 401, leakyHeaders);
      }
      return jsonResponse(postgrestErrorBody, false, 503, leakyHeaders);
    });

    const result = await getHealth({ fetchImpl, timeoutMs: 1000 });
    const serialized = JSON.stringify(result);

    for (const secret of leakySecrets) {
      expect(serialized).not.toContain(secret);
    }

    expect(result.dependencies.database?.status).toBe("down");
    expect(result.dependencies.redis?.status).toBe("down");
    expect(result.dependencies.queue?.status).toBe("down");
    expect(result.httpStatus).toBe(503);

    for (const check of Object.values(result.dependencies)) {
      expect(Object.keys(check).sort()).toEqual(["latencyMs", "status"]);
    }
  });
});
