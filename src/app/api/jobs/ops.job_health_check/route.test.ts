import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/jobs/ops.job_health_check - task 2.5's scheduled-check trigger
// (C1: the first cut of this task shipped checkJobHealth() with zero
// callers anywhere). checkJobHealth() itself is unit-tested at its own
// boundary (src/lib/alerts/job-health.test.ts); this suite is the HTTP
// contract, deliberately mirroring src/app/api/internal/metrics/
// route.test.ts's shape: the bearer gate, 404-not-401 when the route is
// simply not turned on, the token-strength floor, and the rate limit.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  checkJobHealth: vi.fn(),
  checkRateLimit: vi.fn(),
  consoleWarn: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));

vi.mock("@/lib/alerts/job-health", () => ({ checkJobHealth: mocks.checkJobHealth }));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));

vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
}));

const { POST } = await import("./route");

const TOKEN = "a".repeat(24);

const REPORT = {
  checkedAt: "2026-08-06T12:00:00.000Z",
  checkedJobs: 6,
  unhealthy: [],
  alerted: [],
  opsAddressConfigured: true,
  sent: 0,
};

async function callRoute(headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new NextRequest("https://giya.test/api/jobs/ops.job_health_check", { method: "POST", headers }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: null } });
  mocks.checkJobHealth.mockResolvedValue(REPORT);
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
    expect(mocks.checkJobHealth).not.toHaveBeenCalled();
  });

  it("is never cached on the 404 path", async () => {
    vi.stubEnv("METRICS_TOKEN", "");

    const response = await callRoute();

    expect(response.headers.get("Cache-Control")).toMatch(/no-store/);
  });
});

describe("when METRICS_TOKEN is configured but too short to trust", () => {
  it("treats a token shorter than 16 characters as not configured (404)", async () => {
    const shortToken = "a".repeat(8);
    vi.stubEnv("METRICS_TOKEN", shortToken);

    const response = await callRoute({ authorization: `Bearer ${shortToken}` });

    expect(response.status).toBe(404);
    expect(mocks.checkJobHealth).not.toHaveBeenCalled();
  });
});

describe("when METRICS_TOKEN is configured", () => {
  beforeEach(() => {
    vi.stubEnv("METRICS_TOKEN", TOKEN);
  });

  it("refuses a request with no Authorization header", async () => {
    const response = await callRoute();

    expect(response.status).toBe(401);
    expect(mocks.checkJobHealth).not.toHaveBeenCalled();
  });

  it("refuses the wrong bearer token", async () => {
    const response = await callRoute({ authorization: "Bearer wrong-token-wrong-token" });

    expect(response.status).toBe(401);
    expect(mocks.checkJobHealth).not.toHaveBeenCalled();
  });

  it("logs a failed bearer attempt without echoing either token", async () => {
    await callRoute({ authorization: "Bearer wrong-token-wrong-token" });

    expect(mocks.consoleWarn).toHaveBeenCalled();
    const logged = mocks.consoleWarn.mock.calls.map((call) => String(call[0])).join(" ");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("wrong-token-wrong-token");
  });

  it("answers 200 with the report for the correct bearer token", async () => {
    const response = await callRoute({ authorization: `Bearer ${TOKEN}` });
    const body = (await response.json()) as { data: typeof REPORT; meta: { request_id: string } };

    expect(response.status).toBe(200);
    expect(body.data).toEqual(REPORT);
    expect(body.meta.request_id).toBeTruthy();
  });

  it("is never cached", async () => {
    const response = await callRoute({ authorization: `Bearer ${TOKEN}` });

    expect(response.headers.get("Cache-Control")).toMatch(/no-store/);
  });

  it("answers 503 when checkJobHealth reports the service-role client is unavailable", async () => {
    mocks.checkJobHealth.mockResolvedValue(null);

    const response = await callRoute({ authorization: `Bearer ${TOKEN}` });

    expect(response.status).toBe(503);
  });
});

describe("rate limiting bad-bearer attempts", () => {
  beforeEach(() => {
    vi.stubEnv("METRICS_TOKEN", TOKEN);
  });

  it("checks the rate limit even for a WRONG bearer, scoped by IP", async () => {
    await callRoute({ authorization: "Bearer wrong-token-wrong-token" });

    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, windowSeconds: 60 }),
    );
  });

  it("answers 429 once the caller is over budget, without ever comparing the bearer or running the check", async () => {
    mocks.checkRateLimit.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 30 });

    const response = await callRoute({ authorization: `Bearer ${TOKEN}` });

    expect(response.status).toBe(429);
    expect(mocks.checkJobHealth).not.toHaveBeenCalled();
  });
});

describe("dynamic rendering", () => {
  it("declares force-dynamic", async () => {
    const route = await import("./route");
    expect(route.dynamic).toBe("force-dynamic");
  });
});
