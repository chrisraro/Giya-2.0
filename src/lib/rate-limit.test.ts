import { beforeEach, describe, expect, it, vi } from "vitest";

// "server-only" throws on import outside Next.js's react-server condition
// (which vitest does not set), so it must be mocked to a no-op for tests.
vi.mock("server-only", () => ({}));

const redisMocks = vi.hoisted(() => ({
  incr: vi.fn(),
  expireNx: vi.fn(),
  ttl: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  incr: redisMocks.incr,
  expireNx: redisMocks.expireNx,
  ttl: redisMocks.ttl,
}));

describe("checkRateLimit", () => {
  beforeEach(() => {
    redisMocks.incr.mockReset();
    redisMocks.expireNx.mockReset().mockResolvedValue(true);
    redisMocks.ttl.mockReset().mockResolvedValue(60);
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

  it("calls EXPIRE ... NX on every request, not gated behind count === 1", async () => {
    redisMocks.incr.mockResolvedValueOnce(2);
    const { checkRateLimit } = await import("./rate-limit");

    await checkRateLimit({ key: "rl:test", limit: 5, windowSeconds: 60 });

    expect(redisMocks.expireNx).toHaveBeenCalledWith("rl:test", 60);
  });

  it("resets after the window: a fresh INCR of 1 is allowed again and heals the TTL", async () => {
    redisMocks.incr.mockResolvedValueOnce(1);
    const { checkRateLimit } = await import("./rate-limit");

    const result = await checkRateLimit({ key: "rl:test", limit: 5, windowSeconds: 60 });

    expect(result.ok).toBe(true);
    expect(redisMocks.expireNx).toHaveBeenCalledWith("rl:test", 60);
  });

  it("fails open (returns ok: true) and does not throw when Redis errors", async () => {
    redisMocks.incr.mockRejectedValue(new Error("Upstash Redis request failed (500)"));
    const { checkRateLimit } = await import("./rate-limit");

    const result = await checkRateLimit({ key: "rl:test", limit: 5, windowSeconds: 60 });

    expect(result).toEqual({ ok: true, remaining: 5, resetSeconds: 60 });
    expect(console.error).toHaveBeenCalled();
  });

  // --- Fix 1: self-healing TTL (a key that lost its TTL must not stay
  // blocked forever) ---

  it("heal path: attempts to (re-)establish a TTL even when the count is well past 1 (a key that lost its TTL)", async () => {
    // Simulates a key that, due to an earlier fault (process death or Redis
    // blip between an INCR and its EXPIRE), climbed past the limit with no
    // TTL ever set - the exact bug this fix closes. The old
    // `if (count === 1)` guard would never retry EXPIRE for such a key
    // again, since a TTL-less key never resets and so count === 1 never
    // recurs. The fix calls EXPIRE ... NX unconditionally, so this heals on
    // this very call.
    redisMocks.incr.mockResolvedValueOnce(9001);
    redisMocks.expireNx.mockResolvedValueOnce(true); // no TTL existed; NX set one
    redisMocks.ttl.mockResolvedValueOnce(60);
    const { checkRateLimit } = await import("./rate-limit");

    const result = await checkRateLimit({ key: "rl:stuck", limit: 5, windowSeconds: 60 });

    expect(redisMocks.expireNx).toHaveBeenCalledWith("rl:stuck", 60);
    expect(result.ok).toBe(false); // the limit is still enforced for THIS window
    expect(result.resetSeconds).toBe(60); // TTL healed to the full window
  });

  it("is not stuck blocked forever: after the healed TTL expires, the next request starts a fresh window", async () => {
    redisMocks.incr.mockResolvedValueOnce(9001); // stale, TTL-less key from before the fix
    redisMocks.expireNx.mockResolvedValueOnce(true);
    redisMocks.ttl.mockResolvedValueOnce(60);
    const { checkRateLimit } = await import("./rate-limit");

    const stuck = await checkRateLimit({ key: "rl:stuck", limit: 5, windowSeconds: 60 });
    expect(stuck.ok).toBe(false);

    // Once the (now correctly TTL'd) key actually expires in Redis, INCR
    // creates it fresh at 1 - proving the heal unblocks future requests
    // instead of leaving the caller 429'd permanently.
    redisMocks.incr.mockResolvedValueOnce(1);
    redisMocks.expireNx.mockResolvedValueOnce(true);
    redisMocks.ttl.mockResolvedValueOnce(60);
    const fresh = await checkRateLimit({ key: "rl:stuck", limit: 5, windowSeconds: 60 });

    expect(fresh.ok).toBe(true);
  });

  // --- Fix 3: honest Retry-After (resetSeconds must reflect the real TTL,
  // not always the full window) ---

  it("returns the actual remaining TTL as resetSeconds, not the full window", async () => {
    redisMocks.incr.mockResolvedValueOnce(2);
    redisMocks.ttl.mockResolvedValueOnce(37);
    const { checkRateLimit } = await import("./rate-limit");

    const result = await checkRateLimit({ key: "rl:test", limit: 5, windowSeconds: 60 });

    expect(result.resetSeconds).toBe(37);
  });

  it("falls back to the full window when TTL reports no expiry (-1) or a vanished key (-2)", async () => {
    redisMocks.incr.mockResolvedValueOnce(2);
    redisMocks.ttl.mockResolvedValueOnce(-1);
    const { checkRateLimit } = await import("./rate-limit");

    const noTtl = await checkRateLimit({ key: "rl:test", limit: 5, windowSeconds: 60 });
    expect(noTtl.resetSeconds).toBe(60);

    redisMocks.incr.mockResolvedValueOnce(2);
    redisMocks.ttl.mockResolvedValueOnce(-2);
    const vanished = await checkRateLimit({ key: "rl:test", limit: 5, windowSeconds: 60 });
    expect(vanished.resetSeconds).toBe(60);
  });
});
