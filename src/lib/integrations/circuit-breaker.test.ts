import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// An in-memory stand-in for the Upstash REST client, with real TTL semantics
// driven by a fake clock. The breaker's whole behaviour is expiry-driven -
// "open for 30s", "5 failures in 60s" - so a mock that ignores TTLs would
// assert nothing about the thing most likely to be wrong.
const store = vi.hoisted(() => {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  let now = 1_000_000;

  function alive(key: string): { value: string; expiresAt: number } | undefined {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    entries,
    reset(): void {
      entries.clear();
      now = 1_000_000;
    },
    advance(seconds: number): void {
      now += seconds * 1000;
    },
    get now(): number {
      return now;
    },
    alive,
    /** Set when the breaker is meant to see Redis as unreachable. */
    failing: { value: false },
  };
});

function guardOutage(): void {
  if (store.failing.value) throw new Error("redis unreachable (test)");
}

vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
  get: async (key: string) => {
    guardOutage();
    return store.alive(key)?.value ?? null;
  },
  set: async (key: string, value: string, ttl: number) => {
    guardOutage();
    store.entries.set(key, { value, expiresAt: store.now + ttl * 1000 });
    return true;
  },
  setNx: async (key: string, value: string, ttl: number) => {
    guardOutage();
    if (store.alive(key) !== undefined) return false;
    store.entries.set(key, { value, expiresAt: store.now + ttl * 1000 });
    return true;
  },
  del: async (key: string) => {
    guardOutage();
    return store.entries.delete(key) ? 1 : 0;
  },
  incr: async (key: string) => {
    guardOutage();
    const existing = store.alive(key);
    const next = Number(existing?.value ?? "0") + 1;
    store.entries.set(key, {
      value: String(next),
      // A bare INCR on a missing key creates it with no expiry; expireNx sets
      // one. Modelled faithfully because that is exactly the sequence the
      // breaker relies on.
      expiresAt: existing?.expiresAt ?? Number.MAX_SAFE_INTEGER,
    });
    return next;
  },
  expireNx: async (key: string, seconds: number) => {
    guardOutage();
    const existing = store.alive(key);
    if (existing === undefined) return false;
    if (existing.expiresAt !== Number.MAX_SAFE_INTEGER) return false;
    store.entries.set(key, { value: existing.value, expiresAt: store.now + seconds * 1000 });
    return true;
  },
}));

import {
  CircuitOpenError,
  DEFAULT_FAILURE_THRESHOLD,
  circuitState,
  withCircuitBreaker,
} from "./circuit-breaker";

const SERVICE = "probe-service";

/** A call that always fails, so the breaker has something to count. */
async function failing(): Promise<never> {
  throw new Error("dependency down");
}

async function tripBreaker(): Promise<void> {
  for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i += 1) {
    await expect(withCircuitBreaker({ service: SERVICE }, failing)).rejects.toThrow(
      "dependency down",
    );
  }
}

describe("withCircuitBreaker", () => {
  beforeEach(() => {
    store.reset();
    store.failing.value = false;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("passes calls through while closed", async () => {
    const call = vi.fn().mockResolvedValue("ok");
    await expect(withCircuitBreaker({ service: SERVICE }, call)).resolves.toBe("ok");
    expect(call).toHaveBeenCalledTimes(1);
    await expect(circuitState(SERVICE)).resolves.toBe("closed");
  });

  it("re-throws the underlying error unchanged", async () => {
    // The breaker must never convert or wrap a real failure: the caller's own
    // error taxonomy is what the rest of the system branches on.
    const boom = new TypeError("very specific");
    await expect(
      withCircuitBreaker({ service: SERVICE }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("opens after exactly five consecutive failures", async () => {
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD - 1; i += 1) {
      await expect(withCircuitBreaker({ service: SERVICE }, failing)).rejects.toThrow(
        "dependency down",
      );
      expect(await circuitState(SERVICE)).toBe("closed");
    }

    await expect(withCircuitBreaker({ service: SERVICE }, failing)).rejects.toThrow(
      "dependency down",
    );
    expect(await circuitState(SERVICE)).toBe("open");
  });

  it("rejects without invoking the dependency once open", async () => {
    await tripBreaker();

    const call = vi.fn().mockResolvedValue("ok");
    await expect(withCircuitBreaker({ service: SERVICE }, call)).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    // The point of the whole mechanism: the dependency is not touched.
    expect(call).not.toHaveBeenCalled();
  });

  it("does not open when failures are spread beyond the 60s window", async () => {
    // The counter's TTL is what makes them "consecutive failures in 60s"
    // rather than "five failures ever".
    for (let i = 0; i < 10; i += 1) {
      await expect(withCircuitBreaker({ service: SERVICE }, failing)).rejects.toThrow();
      store.advance(61);
    }
    expect(await circuitState(SERVICE)).toBe("closed");
  });

  it("clears the count on any success", async () => {
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD - 1; i += 1) {
      await expect(withCircuitBreaker({ service: SERVICE }, failing)).rejects.toThrow();
    }
    await expect(
      withCircuitBreaker({ service: SERVICE }, async () => "ok"),
    ).resolves.toBe("ok");

    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD - 1; i += 1) {
      await expect(withCircuitBreaker({ service: SERVICE }, failing)).rejects.toThrow();
    }
    expect(await circuitState(SERVICE)).toBe("closed");
  });

  it("goes half-open after 30s and admits exactly one probe", async () => {
    await tripBreaker();
    store.advance(31);
    expect(await circuitState(SERVICE)).toBe("half_open");

    // Two callers race the probe lock. Only one reaches the dependency.
    const slow = vi.fn(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 0)),
    );
    const [first, second] = await Promise.allSettled([
      withCircuitBreaker({ service: SERVICE }, slow),
      withCircuitBreaker({ service: SERVICE }, slow),
    ]);

    expect(first).toEqual({ status: "fulfilled", value: "ok" });
    expect(second.status).toBe("rejected");
    expect(second.status === "rejected" ? second.reason : null).toBeInstanceOf(CircuitOpenError);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("closes fully when the probe succeeds", async () => {
    await tripBreaker();
    store.advance(31);
    await expect(withCircuitBreaker({ service: SERVICE }, async () => "ok")).resolves.toBe("ok");
    expect(await circuitState(SERVICE)).toBe("closed");
  });

  it("re-opens on a SINGLE failed probe rather than demanding five more", async () => {
    // Without the half-open marker the counter (reset when the circuit opened)
    // would need five fresh failures, so a dependency that is still down would
    // be hit five times per recovery window, forever.
    await tripBreaker();
    store.advance(31);
    expect(await circuitState(SERVICE)).toBe("half_open");

    await expect(withCircuitBreaker({ service: SERVICE }, failing)).rejects.toThrow();
    expect(await circuitState(SERVICE)).toBe("open");
  });

  it("ignores failures the caller says are not the dependency's fault", async () => {
    // A 400 caused by our own bad request must not open a circuit for every
    // other tenant.
    const isFailure = (error: unknown): boolean =>
      !(error instanceof Error && error.message === "our fault");

    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD * 2; i += 1) {
      await expect(
        withCircuitBreaker({ service: SERVICE, isFailure }, async () => {
          throw new Error("our fault");
        }),
      ).rejects.toThrow("our fault");
    }
    expect(await circuitState(SERVICE)).toBe("closed");
  });

  it("releases the probe lock when the probe failed for our own reason", async () => {
    const isFailure = (error: unknown): boolean =>
      !(error instanceof Error && error.message === "our fault");

    await tripBreaker();
    store.advance(31);

    await expect(
      withCircuitBreaker({ service: SERVICE, isFailure }, async () => {
        throw new Error("our fault");
      }),
    ).rejects.toThrow("our fault");

    // Still half-open (the probe learned nothing), and the NEXT caller gets to
    // ask the real question instead of waiting out the lock's TTL.
    expect(await circuitState(SERVICE)).toBe("half_open");
    const call = vi.fn().mockResolvedValue("ok");
    await expect(withCircuitBreaker({ service: SERVICE }, call)).resolves.toBe("ok");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("honours per-service overrides", async () => {
    await expect(
      withCircuitBreaker({ service: "tiny", failureThreshold: 1 }, failing),
    ).rejects.toThrow();
    expect(await circuitState("tiny")).toBe("open");
    // and the other service's circuit is untouched
    expect(await circuitState(SERVICE)).toBe("closed");
  });

  it("FAILS OPEN when Redis is unreachable", async () => {
    // The deliberate counterpoint to the idempotency gate and the redemption
    // token, both of which fail closed. A breaker that fails closed
    // manufactures the outage it exists to contain.
    store.failing.value = true;

    const call = vi.fn().mockResolvedValue("ok");
    await expect(withCircuitBreaker({ service: SERVICE }, call)).resolves.toBe("ok");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("reports closed when the state cannot be read", async () => {
    store.failing.value = true;
    await expect(circuitState(SERVICE)).resolves.toBe("closed");
  });

  it("does not turn a successful call into a failure when bookkeeping fails", async () => {
    const call = vi.fn(async () => {
      // Redis dies between the admission check and the success recording.
      store.failing.value = true;
      return "ok";
    });
    await expect(withCircuitBreaker({ service: SERVICE }, call)).resolves.toBe("ok");
  });
});
