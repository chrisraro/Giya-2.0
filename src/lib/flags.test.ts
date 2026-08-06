// @vitest-environment node
//
// Server-only module (service-role Supabase reads, an in-memory TTL cache);
// no DOM anywhere in it, so it runs under plain Node like the other server
// modules in this codebase.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// "server-only" throws on import outside Next.js's react-server condition
// (which vitest does not set), so it must be mocked to a no-op for tests.
vi.mock("server-only", () => ({}));

const createServiceRoleClient = vi.fn();
vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

import {
  AI_ANALYTICS_FLAG,
  AI_ASSISTANT_FLAG,
  AI_PARSE_ASSIST_FLAG,
  __resetFeatureFlagCacheForTests,
  isFeatureEnabled,
} from "./flags";

interface FakeResult {
  data: { is_enabled: boolean } | null;
  error: { message: string } | null;
}

/** A fake client whose `feature_flags` read is scripted per call, and whose
 * `eq("key", ...)` argument is recorded so a test can assert which key was
 * actually queried. */
function fakeClient(respond: (key: string) => FakeResult) {
  const eqCalls: string[] = [];
  return {
    client: {
      from: (table: string) => {
        expect(table).toBe("feature_flags");
        return {
          select: (columns: string) => {
            expect(columns).toBe("is_enabled");
            return {
              eq: (column: string, value: string) => {
                expect(column).toBe("key");
                eqCalls.push(value);
                return {
                  maybeSingle: () => Promise.resolve(respond(value)),
                };
              },
            };
          },
        };
      },
    },
    eqCalls,
  };
}

function throwingClient(error: Error) {
  return {
    from: () => {
      throw error;
    },
  };
}

beforeEach(() => {
  __resetFeatureFlagCacheForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("isFeatureEnabled: reading the row", () => {
  it("returns true when the row is enabled", async () => {
    const { client } = fakeClient(() => ({ data: { is_enabled: true }, error: null }));
    createServiceRoleClient.mockReturnValue(client);

    await expect(isFeatureEnabled(AI_PARSE_ASSIST_FLAG)).resolves.toBe(true);
    // Named mutant: hardcode the return to `false` regardless of `data.is_enabled`.
    // This assertion is what kills it - a flag genuinely on must read as on.
  });

  it("returns false when the row is disabled", async () => {
    const { client } = fakeClient(() => ({ data: { is_enabled: false }, error: null }));
    createServiceRoleClient.mockReturnValue(client);

    await expect(isFeatureEnabled(AI_ASSISTANT_FLAG)).resolves.toBe(false);
    // Named mutant: hardcode the return to `true` regardless of `data.is_enabled`.
    // Paired with the "returns true" case above, the two together kill a
    // mutant that ignores `data.is_enabled` entirely and returns a constant.
  });

  it("queries the exact key it was asked about", async () => {
    const { client, eqCalls } = fakeClient(() => ({ data: { is_enabled: true }, error: null }));
    createServiceRoleClient.mockReturnValue(client);

    await isFeatureEnabled(AI_ANALYTICS_FLAG);

    expect(eqCalls).toEqual([AI_ANALYTICS_FLAG]);
    // Named mutant: query a hardcoded key (e.g. always "ai_parse_assist")
    // instead of the caller's `key` argument. This is the assertion that
    // kills it - a different flag would silently read another flag's state.
  });
});

describe("isFeatureEnabled: fails closed on every uncertainty", () => {
  it("reads false when the row does not exist", async () => {
    const { client } = fakeClient(() => ({ data: null, error: null }));
    createServiceRoleClient.mockReturnValue(client);

    await expect(isFeatureEnabled("unregistered_key")).resolves.toBe(false);
    // Named mutant: return `true` when `data === null`. Killed by this
    // assertion - an unregistered/deleted flag must never read as "on".
  });

  it("reads false when the query errors", async () => {
    const { client } = fakeClient(() => ({
      data: null,
      error: { message: "connection reset" },
    }));
    createServiceRoleClient.mockReturnValue(client);

    await expect(isFeatureEnabled(AI_PARSE_ASSIST_FLAG)).resolves.toBe(false);
    // Named mutant: ignore `error` and fall through to reading `data.is_enabled`
    // (which would throw on a null `data`, or read a stale value). Killed by
    // this assertion resolving cleanly to `false` rather than rejecting or
    // reading something other than false.
  });

  it("reads false when the service-role client is unavailable (no key configured)", async () => {
    createServiceRoleClient.mockReturnValue(null);

    await expect(isFeatureEnabled(AI_PARSE_ASSIST_FLAG)).resolves.toBe(false);
    // Named mutant: skip the `client === null` guard and call `.from()` on
    // null. Killed because that would throw/reject, not resolve to `false`.
  });

  it("reads false when creating the service-role client throws", async () => {
    createServiceRoleClient.mockImplementation(() => {
      throw new Error("env schema validation failed");
    });

    await expect(isFeatureEnabled(AI_PARSE_ASSIST_FLAG)).resolves.toBe(false);
    // Named mutant: remove the try/catch around `createServiceRoleClient()`.
    // Killed because the promise would reject instead of resolving false.
  });

  it("reads false when the client throws instead of rejecting", async () => {
    createServiceRoleClient.mockReturnValue(throwingClient(new Error("boom")));

    await expect(isFeatureEnabled(AI_PARSE_ASSIST_FLAG)).resolves.toBe(false);
    // Named mutant: drop the inner try/catch around the `.from(...)` chain.
    // Killed the same way as the case above, for the synchronous-throw path.
  });
});

describe("isFeatureEnabled: the 30s cache", () => {
  it("does not re-read within the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T00:00:00.000Z"));

    let calls = 0;
    const { client } = fakeClient(() => {
      calls += 1;
      return { data: { is_enabled: true }, error: null };
    });
    createServiceRoleClient.mockReturnValue(client);

    await expect(isFeatureEnabled(AI_PARSE_ASSIST_FLAG)).resolves.toBe(true);
    vi.setSystemTime(new Date("2026-08-06T00:00:29.000Z")); // +29s, inside the TTL
    await expect(isFeatureEnabled(AI_PARSE_ASSIST_FLAG)).resolves.toBe(true);

    expect(calls).toBe(1);
    // Named mutant: force the cache to never expire (drop the `expiresAt`
    // check and always return the cached value) - this specific assertion
    // does NOT kill that mutant (a permanent cache also reads 1 call here).
    // It is killed by the next test instead; see that test's note.
  });

  it("re-reads after the TTL expires, and picks up a changed value", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T00:00:00.000Z"));

    let calls = 0;
    let enabled = true;
    const { client } = fakeClient(() => {
      calls += 1;
      return { data: { is_enabled: enabled }, error: null };
    });
    createServiceRoleClient.mockReturnValue(client);

    await expect(isFeatureEnabled(AI_PARSE_ASSIST_FLAG)).resolves.toBe(true);

    enabled = false; // the operator flips the switch off mid-window
    vi.setSystemTime(new Date("2026-08-06T00:00:30.001Z")); // +30.001s, past the TTL
    await expect(isFeatureEnabled(AI_PARSE_ASSIST_FLAG)).resolves.toBe(false);

    expect(calls).toBe(2);
    // Named mutant: force the cache to never expire (`expiresAt = Infinity`,
    // or drop the expiry check entirely). Killed here: a permanent cache
    // would still return `true` (the stale first read) and `calls` would
    // stay 1, so both the value and the call count fail this assertion.
  });

  it("caches a failed read too, at the same TTL (does not hammer a down dependency)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T00:00:00.000Z"));

    let calls = 0;
    const { client } = fakeClient(() => {
      calls += 1;
      return { data: null, error: { message: "down" } };
    });
    createServiceRoleClient.mockReturnValue(client);

    await isFeatureEnabled(AI_PARSE_ASSIST_FLAG);
    vi.setSystemTime(new Date("2026-08-06T00:00:10.000Z"));
    await isFeatureEnabled(AI_PARSE_ASSIST_FLAG);

    expect(calls).toBe(1);
    // Named mutant: skip caching on the failure path (only `cache.set` on a
    // successful read). Killed because the second call would re-query,
    // making `calls` 2.
  });

  it("caches each key independently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T00:00:00.000Z"));

    const calls: Record<string, number> = {};
    const { client } = fakeClient((key) => {
      calls[key] = (calls[key] ?? 0) + 1;
      return { data: { is_enabled: key === AI_PARSE_ASSIST_FLAG }, error: null };
    });
    createServiceRoleClient.mockReturnValue(client);

    await expect(isFeatureEnabled(AI_PARSE_ASSIST_FLAG)).resolves.toBe(true);
    await expect(isFeatureEnabled(AI_ASSISTANT_FLAG)).resolves.toBe(false);
    await expect(isFeatureEnabled(AI_PARSE_ASSIST_FLAG)).resolves.toBe(true);

    expect(calls[AI_PARSE_ASSIST_FLAG]).toBe(1);
    expect(calls[AI_ASSISTANT_FLAG]).toBe(1);
    // Named mutant: key the cache by a constant instead of the flag key
    // (e.g. a single-entry cache). Killed because ai_assistant's read would
    // then either short-circuit to ai_parse_assist's cached `true`, or
    // clobber it - either way one of the two `calls` counts above goes wrong.
  });
});
