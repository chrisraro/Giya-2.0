import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/internal/metrics - the operator-only probe behind doc 52's "the
// metrics probe" (a QStash schedule invokes it every minute). loadMetrics()
// itself is unit-tested at its own boundary
// (src/lib/observability/metrics.test.ts); this suite is the HTTP contract:
// the bearer gate, and 404-not-401 when the endpoint is simply not turned on
// for this deployment (t2-3-brief.md: "when the var is ABSENT the route
// returns 404, not 500 and not an open endpoint").

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  loadMetrics: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));

vi.mock("@/lib/observability/metrics", () => ({ loadMetrics: mocks.loadMetrics }));

// Same module-graph reason as src/app/api/v1/health/route.test.ts.
vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
}));

const { GET } = await import("./route");

const TOKEN = "a".repeat(24);

const REPORT = {
  jobs: {
    byStatus: { queued: 1, running: 0, succeeded: 10, failed: 0, dead: 2 },
    deadLetterCount: 2,
  },
  sweepJobHealth: [
    {
      jobname: "claims-expiry-sweep",
      schedule: "7 * * * *",
      active: true,
      runs: 24,
      failures: 0,
      lastStatus: "succeeded",
      lastFinishedAt: "2026-08-06T03:07:00.000Z",
      lastError: null,
    },
  ],
};

async function callRoute(headers: Record<string, string> = {}): Promise<Response> {
  return GET(
    new NextRequest("https://giya.test/api/internal/metrics", { method: "GET", headers }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: null } });
  mocks.loadMetrics.mockResolvedValue(REPORT);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("when METRICS_TOKEN is not configured", () => {
  it("answers 404, never 500 and never an open endpoint", async () => {
    vi.stubEnv("METRICS_TOKEN", "");

    const response = await callRoute({ authorization: `Bearer ${TOKEN}` });

    expect(response.status).toBe(404);
    expect(mocks.loadMetrics).not.toHaveBeenCalled();
  });

  it("answers 404 even with no Authorization header at all", async () => {
    vi.stubEnv("METRICS_TOKEN", "");

    const response = await callRoute();

    expect(response.status).toBe(404);
  });
});

describe("when METRICS_TOKEN is configured", () => {
  beforeEach(() => {
    vi.stubEnv("METRICS_TOKEN", TOKEN);
  });

  it("refuses a request with no Authorization header", async () => {
    const response = await callRoute();

    expect(response.status).toBe(401);
    expect(mocks.loadMetrics).not.toHaveBeenCalled();
  });

  it("refuses the wrong bearer token", async () => {
    const response = await callRoute({ authorization: "Bearer wrong-token-wrong-token" });

    expect(response.status).toBe(401);
    expect(mocks.loadMetrics).not.toHaveBeenCalled();
  });

  it("refuses a non-Bearer Authorization scheme", async () => {
    const response = await callRoute({ authorization: `Basic ${TOKEN}` });

    expect(response.status).toBe(401);
  });

  it("answers 200 with the documented shape for the correct bearer token", async () => {
    const response = await callRoute({ authorization: `Bearer ${TOKEN}` });
    const body = (await response.json()) as { data: typeof REPORT; meta: { request_id: string } };

    expect(response.status).toBe(200);
    expect(body.data.jobs.byStatus).toEqual(REPORT.jobs.byStatus);
    expect(body.data.jobs.deadLetterCount).toBe(2);
    expect(body.meta.request_id).toBeTruthy();
  });

  it("passes the sweep_job_health rows through unmodified", async () => {
    const response = await callRoute({ authorization: `Bearer ${TOKEN}` });
    const body = (await response.json()) as { data: typeof REPORT };

    expect(body.data.sweepJobHealth).toEqual(REPORT.sweepJobHealth);
  });

  it("is never cached", async () => {
    const response = await callRoute({ authorization: `Bearer ${TOKEN}` });

    expect(response.headers.get("Cache-Control")).toMatch(/no-store/);
  });

  it("answers 503 rather than a partial report when the underlying read fails", async () => {
    mocks.loadMetrics.mockResolvedValue(null);

    const response = await callRoute({ authorization: `Bearer ${TOKEN}` });

    expect(response.status).toBe(503);
  });
});

describe("dynamic rendering", () => {
  it("declares force-dynamic", async () => {
    const route = await import("./route");
    expect(route.dynamic).toBe("force-dynamic");
  });
});
