import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/v1/health - the public liveness/readiness probe (doc 52's
// synthetic uptime monitor target). getHealth() itself is unit-tested at its
// own boundary (src/lib/observability/health.test.ts, including the leak
// test); this suite is the HTTP contract: doc 13's envelope, the 200/503
// split, no session required, and never cached.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getHealth: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));

vi.mock("@/lib/observability/health", () => ({ getHealth: mocks.getHealth }));

// defineHandler's module graph reaches src/lib/redis.ts (idempotency +
// rate-limit helpers) even though this route configures neither. That module
// reads @/lib/env at call time, which throws without real Supabase env vars
// - so it is stubbed the same way src/app/api/v1/geocode/route.test.ts stubs
// it, to keep this suite about the HTTP contract and not about env wiring.
vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
}));

const { GET } = await import("./route");

async function callRoute(): Promise<Response> {
  return GET(new NextRequest("https://giya.test/api/v1/health", { method: "GET" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // No session cookie on a health probe - a route that required one would be
  // wrong, and this pins that GET never depends on auth succeeding.
  mocks.getUser.mockResolvedValue({ data: { user: null } });
});

describe("when every dependency is up", () => {
  beforeEach(() => {
    mocks.getHealth.mockResolvedValue({
      httpStatus: 200,
      dependencies: {
        database: { status: "ok", latencyMs: 12 },
        redis: { status: "ok", latencyMs: 4 },
      },
    });
  });

  it("answers 200 inside doc 13's envelope", async () => {
    const response = await callRoute();
    const body = (await response.json()) as {
      data: { status: string; dependencies: Record<string, unknown> };
      meta: { request_id: string };
    };

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("ok");
    expect(body.data.dependencies.database).toEqual({ status: "ok", latencyMs: 12 });
    expect(body.meta.request_id).toBeTruthy();
  });

  it("carries a request id header even with no session on the request", async () => {
    const response = await callRoute();

    expect(response.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("is never cached", async () => {
    const response = await callRoute();

    expect(response.headers.get("Cache-Control")).toMatch(/no-store/);
  });
});

describe("when a hard dependency is down", () => {
  it("answers 503 with the per-dependency detail, not a generic error envelope", async () => {
    mocks.getHealth.mockResolvedValue({
      httpStatus: 503,
      dependencies: {
        database: { status: "down", latencyMs: 3001 },
        redis: { status: "ok", latencyMs: 5 },
      },
    });

    const response = await callRoute();
    const body = (await response.json()) as { data: { status: string; dependencies: unknown } };

    expect(response.status).toBe(503);
    expect(body.data.status).toBe("down");
    expect(body.data.dependencies).toMatchObject({ database: { status: "down" } });
  });

  it("is still never cached on the failure path", async () => {
    mocks.getHealth.mockResolvedValue({
      httpStatus: 503,
      dependencies: { database: { status: "down", latencyMs: 1 }, redis: { status: "ok", latencyMs: 1 } },
    });

    const response = await callRoute();

    expect(response.headers.get("Cache-Control")).toMatch(/no-store/);
  });
});

describe("dynamic rendering", () => {
  it("declares force-dynamic so the platform never caches a stale liveness answer", async () => {
    const route = await import("./route");
    expect(route.dynamic).toBe("force-dynamic");
  });
});
