import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/v1/health - the REAL-route leak contract.
//
// src/lib/observability/health.test.ts unit-tests getHealth() directly, and
// src/app/api/v1/health/route.test.ts mocks getHealth() wholesale to pin the
// HTTP contract (status codes, envelope shape, caching). Neither proves the
// two coincide: a bug that only shows up in how the ROUTE serializes
// getHealth()'s return into an actual Response would pass both suites.
//
// This file runs the REAL route with the REAL getHealth() - nothing under
// src/lib/observability/** is mocked - stubbing only the global `fetch` that
// getHealth() calls through, and asserts on the actual `Response` the route
// handler produces: its serialized JSON body AND its headers.

vi.mock("server-only", () => ({}));

const SUPABASE_URL = "https://example.supabase.co";
const ANON_KEY = "sb_publishable_abcdefghijklmnopqrstuvwxyz";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
  })),
}));

// Module-graph stub, same reason as route.test.ts beside this file.
vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
}));

// Queue left "not configured" throughout this file - the queue's own
// leak-through-a-non-2xx-response behaviour is exercised at the unit level
// in health.test.ts; this file's job is proving the ROUTE doesn't introduce
// a leak of its own, which database + redis already demonstrate.
vi.mock("@/lib/queue/publish", () => ({ isQueueConfigured: () => false }));

const { GET } = await import("./route");

function jsonResponse(
  body: unknown,
  ok = true,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

async function callRoute(): Promise<Response> {
  return GET(new NextRequest("https://giya.test/api/v1/health", { method: "GET" }));
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "a".repeat(20));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the real route, driven by the real getHealth()", () => {
  it("answers 200 through the genuine pipeline when every hard dependency is healthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("upstash.io")) return jsonResponse({ result: "PONG" });
        return jsonResponse([{ id: "1" }]);
      }),
    );

    const response = await callRoute();
    const body = (await response.json()) as { data: { status: string } };

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("ok");
  });

  // I3: proves the no-leak guarantee holds all the way to the actual bytes
  // a caller receives, not only to getHealth()'s in-memory return value -
  // body AND headers, on a realistic non-2xx failure from each hard
  // dependency.
  it("never lets a non-2xx dependency response's body or headers reach the actual serialized HTTP response", async () => {
    const postgrestErrorBody = {
      code: "PGRST301",
      message: 'JWT expired for role "authenticated" on schema "receipts_private"',
      hint: 'relation "receipts_private.audit_logs" access denied',
    };
    const upstashErrorBody = { error: "Unauthorized" };
    const leakySecrets = [
      "PGRST301",
      "receipts_private",
      "audit_logs",
      "authenticated",
      "Unauthorized",
      ANON_KEY,
      SUPABASE_URL,
      "PostgREST/12.2.0",
    ];
    const leakyHeaders = { server: "PostgREST/12.2.0" };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("upstash.io")) {
          return jsonResponse(upstashErrorBody, false, 401, leakyHeaders);
        }
        return jsonResponse(postgrestErrorBody, false, 503, leakyHeaders);
      }),
    );

    const response = await callRoute();
    const rawBody = await response.text();
    const allResponseHeaders = JSON.stringify(Object.fromEntries(response.headers.entries()));

    expect(response.status).toBe(503);
    for (const secret of leakySecrets) {
      expect(rawBody).not.toContain(secret);
      expect(allResponseHeaders).not.toContain(secret);
    }

    const parsed = JSON.parse(rawBody) as {
      data: { status: string; dependencies: Record<string, { status: string; latencyMs: number }> };
    };
    expect(parsed.data.status).toBe("down");
    expect(parsed.data.dependencies.database?.status).toBe("down");
    expect(parsed.data.dependencies.redis?.status).toBe("down");
    for (const check of Object.values(parsed.data.dependencies)) {
      expect(Object.keys(check).sort()).toEqual(["latencyMs", "status"]);
    }
  });
});
