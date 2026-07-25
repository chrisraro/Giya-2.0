import { beforeEach, describe, expect, it, vi } from "vitest";

// "server-only" throws on import outside Next.js's react-server condition
// (which vitest does not set), so it must be mocked to a no-op for tests.
vi.mock("server-only", () => ({}));

const redisMocks = vi.hoisted(() => ({
  incr: vi.fn(),
  expire: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  incr: redisMocks.incr,
  expire: redisMocks.expire,
}));

describe("checkRateLimit", () => {
  beforeEach(() => {
    redisMocks.incr.mockReset();
    redisMocks.expire.mockReset().mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("allows requests up to the limit", async () => {
    redisMocks.incr
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);
    const { checkRateLimit } = await import("./rate-limit");

    for (let i = 0; i < 3; i += 1) {
      const result = await checkRateLimit({
        key: "rl:test",
        limit: 3,
        windowSeconds: 60,
      });
      expect(result.ok).toBe(true);
    }
  });

  it("blocks once the count exceeds the limit", async () => {
    redisMocks.incr.mockResolvedValueOnce(4);
    const { checkRateLimit } = await import("./rate-limit");

    const result = await checkRateLimit({ key: "rl:test", limit: 3, windowSeconds: 60 });

    expect(result.ok).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("sets the TTL only on the first increment of a window", async () => {
    redisMocks.incr.mockResolvedValueOnce(1);
    const { checkRateLimit } = await import("./rate-limit");

    await checkRateLimit({ key: "rl:test", limit: 5, windowSeconds: 60 });

    expect(redisMocks.expire).toHaveBeenCalledWith("rl:test", 60);
  });

  it("does not re-set the TTL on later increments in the same window", async () => {
    redisMocks.incr.mockResolvedValueOnce(2);
    const { checkRateLimit } = await import("./rate-limit");

    await checkRateLimit({ key: "rl:test", limit: 5, windowSeconds: 60 });

    expect(redisMocks.expire).not.toHaveBeenCalled();
  });

  it("resets after the window: a fresh INCR of 1 is allowed again and re-sets the TTL", async () => {
    redisMocks.incr.mockResolvedValueOnce(1);
    const { checkRateLimit } = await import("./rate-limit");

    const result = await checkRateLimit({ key: "rl:test", limit: 5, windowSeconds: 60 });

    expect(result.ok).toBe(true);
    expect(redisMocks.expire).toHaveBeenCalledWith("rl:test", 60);
  });

  it("fails open (returns ok: true) and does not throw when Redis errors", async () => {
    redisMocks.incr.mockRejectedValue(new Error("Upstash Redis request failed (500)"));
    const { checkRateLimit } = await import("./rate-limit");

    const result = await checkRateLimit({ key: "rl:test", limit: 5, windowSeconds: 60 });

    expect(result).toEqual({ ok: true, remaining: 5, resetSeconds: 60 });
    expect(console.error).toHaveBeenCalled();
  });
});
