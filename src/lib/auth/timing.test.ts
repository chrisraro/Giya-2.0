import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withMinDelay } from "./timing";

describe("withMinDelay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pads a fast-resolving operation so it never settles before minMs", async () => {
    const promise = withMinDelay(async () => "fast", 1000);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // The operation itself resolves on the next microtask; give it a chance
    // to do so without advancing the clock, then confirm the wrapper is
    // still holding it back.
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await promise).toBe("fast");
  });

  it("adds no extra wait once the operation itself already took longer than minMs", async () => {
    const promise = withMinDelay(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return "slow";
    }, 1000);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // The operation's own 1500ms already exceeds minMs, so it should settle
    // exactly when its own delay elapses - not 1000ms later on top of that.
    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await promise).toBe("slow");
  });

  it("still pads a fast-rejecting operation and rethrows the original error unchanged", async () => {
    const boom = new Error("boom");
    const promise = withMinDelay(async () => {
      throw boom;
    }, 1000);
    let rejection: unknown;
    void promise.catch((err: unknown) => {
      rejection = err;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(rejection).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(rejection).toBe(boom);
  });
});
