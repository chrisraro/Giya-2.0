import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/internal/metrics - the operator-only probe behind doc 52's "the
// metrics probe" (a QStash schedule invokes it every minute). loadMetrics()
// itself is unit-tested at its own boundary
// (src/lib/observability/metrics.test.ts); this suite is the HTTP contract:
// the bearer gate, 404-not-401 when the endpoint is simply not turned on for
// this deployment, the token-strength floor, and the rate limit that bounds
// bearer guessing (I6).

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  loadMetrics: vi.fn(),
  checkRateLimit: vi.fn(),
  consoleWarn: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));

vi.mock("@/lib/observability/metrics", () => ({ loadMetrics: mocks.loadMetrics }));

// The route now configures rateLimit (I6), so defineHandler genuinely calls
// this rather than merely importing its module graph.
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));

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
  mocks.checkRateLimit.mockResolvedValue({ ok: true, remaining: 19, resetSeconds: 60 });
  vi.spyOn(console, "warn").mockImplementation(mocks.consoleWarn);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

  it("is never cached on the 404 path", async () => {
    vi.stubEnv("METRICS_TOKEN", "");

    const response = await callRoute();

    expect(response.headers.get("Cache-Control")).toMatch(/no-store/);
  });
});

// I1: the schema-level floor was removed from src/lib/env.ts (a `.min()`
// there would make getServerEnv() throw for every OTHER caller on a
// truncated token). The floor now lives here; below it, a configured token
// reads as unconfigured (404) rather than as a working but weak credential.
describe("when METRICS_TOKEN is configured but too short to trust", () => {
  it("treats a token shorter than 16 characters as not configured (404), not as a weak-but-valid bearer", async () => {
    const shortToken = "a".repeat(8);
    vi.stubEnv("METRICS_TOKEN", shortToken);

    const response = await callRoute({ authorization: `Bearer ${shortToken}` });

    expect(response.status).toBe(404);
    expect(mocks.loadMetrics).not.toHaveBeenCalled();
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

  it("logs a failed bearer attempt without echoing either token", async () => {
    await callRoute({ authorization: "Bearer wrong-token-wrong-token" });

    expect(mocks.consoleWarn).toHaveBeenCalled();
    const logged = mocks.consoleWarn.mock.calls.map((call) => String(call[0])).join(" ");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("wrong-token-wrong-token");
  });

  it("is never cached on the 401 path", async () => {
    const response = await callRoute();

    expect(response.headers.get("Cache-Control")).toMatch(/no-store/);
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

  it("is never cached on the 503 path", async () => {
    mocks.loadMetrics.mockResolvedValue(null);

    const response = await callRoute({ authorization: `Bearer ${TOKEN}` });

    expect(response.headers.get("Cache-Control")).toMatch(/no-store/);
  });
});

// I6: unlimited bearer guessing must be bounded, and it must be bounded by
// the RATE LIMITER, not merely by the token's own entropy - the pipeline
// order below is what makes that true (see route.ts's own comment on why
// the bearer comparison runs in the handler, after rate limiting, rather
// than in `authorize`).
describe("rate limiting bad-bearer attempts (I6)", () => {
  beforeEach(() => {
    vi.stubEnv("METRICS_TOKEN", TOKEN);
  });

  it("checks the rate limit even for a WRONG bearer, scoped by IP", async () => {
    await callRoute({ authorization: "Bearer wrong-token-wrong-token" });

    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, windowSeconds: 60 }),
    );
  });

  it("answers 429 once the caller is over budget, without ever comparing the bearer or reading metrics", async () => {
    mocks.checkRateLimit.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 30 });

    const response = await callRoute({ authorization: `Bearer ${TOKEN}` });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(mocks.loadMetrics).not.toHaveBeenCalled();
  });
});

describe("dynamic rendering", () => {
  it("declares force-dynamic", async () => {
    const route = await import("./route");
    expect(route.dynamic).toBe("force-dynamic");
  });
});
