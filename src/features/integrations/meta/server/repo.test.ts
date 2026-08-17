// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));

const supabaseMock = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: supabaseMock.createClient }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import { CLIENT_COLUMNS, TOKEN_COLUMNS, assertClientColumns, listConnections, readConnections } from "./repo";

// =============================================================================
// The column allowlist, asserted directly.
// =============================================================================
//
// supabase/tests/rls_integration_connections_smoke.sql proves the DATABASE
// refuses a client read of a token column (42501). This file proves the
// FEATURE never asks, which is the fence that fails first, in development,
// with a message naming the line that was crossed rather than a bare Postgres
// error from inside a query builder.
//
// The two are not redundant. The database fence binds every caller including
// ones written in five years by someone who has not read this file; this one
// binds the caller in front of it and explains why.

describe("the client column allowlist", () => {
  it("does not contain either token column", () => {
    // THE assertion. If a future edit adds one to the allowlist, this fails
    // here rather than in a response body.
    for (const column of TOKEN_COLUMNS) {
      expect(CLIENT_COLUMNS as readonly string[]).not.toContain(column);
    }
  });

  it("mirrors migration 0032's grant for everything the portal renders", () => {
    // Pinned literally: a column silently dropped from this list is a settings
    // card that stops showing an expiry or a status, and a column silently
    // ADDED is a 42501 at runtime because the grant does not include it.
    expect([...CLIENT_COLUMNS]).toEqual([
      "id",
      "status",
      "external_account_id",
      "external_account_name",
      "scopes",
      "token_expires_at",
      "last_synced_at",
      "error",
      "created_at",
    ]);
  });

  it("names both token columns so the fence covers refresh tokens too", () => {
    expect([...TOKEN_COLUMNS]).toEqual([
      "access_token_encrypted",
      "refresh_token_encrypted",
    ]);
  });
});

describe("assertClientColumns", () => {
  it("accepts the allowlist itself", () => {
    expect(() => assertClientColumns([...CLIENT_COLUMNS])).not.toThrow();
  });

  it("accepts a narrower read", () => {
    expect(() => assertClientColumns(["id", "status"])).not.toThrow();
  });

  it("REFUSES A READ THAT NAMES THE ACCESS TOKEN", () => {
    expect(() => assertClientColumns(["id", "access_token_encrypted"])).toThrow(
      /access_token_encrypted/,
    );
  });

  it("REFUSES A READ THAT NAMES THE REFRESH TOKEN", () => {
    expect(() => assertClientColumns(["refresh_token_encrypted"])).toThrow(
      /refresh_token_encrypted/,
    );
  });

  it("explains where tokens are actually read, so the fix is obvious", () => {
    // A refusal that does not say what to do instead gets worked around.
    expect(() => assertClientColumns(["access_token_encrypted"])).toThrow(/tokens\.ts/);
  });

  it("refuses a column outside the grant, even a harmless one", () => {
    // `business_id` is granted by the migration but is not something the
    // portal reads, and an allowlist that quietly tolerates extras is not an
    // allowlist.
    expect(() => assertClientColumns(["id", "business_id"])).toThrow(/business_id/);
  });

  it("names every trespassing column at once", () => {
    expect(() =>
      assertClientColumns(["access_token_encrypted", "refresh_token_encrypted"]),
    ).toThrow(/access_token_encrypted, refresh_token_encrypted/);
  });
});

// =============================================================================
// readConnections: THE PRODUCER OF THE ok/failed DISCRIMINANT.
// =============================================================================
//
// Everything above this line tests the column fence. This block tests the one
// thing the whole `read_failed` state rests on, and it was written because
// both of this function's failure exits survived removal while eight
// consumer-side assertions stayed green.
//
// That is the point worth keeping. `capability.test.ts` and `insights.test.ts`
// mock `readConnections` and assert richly on both sides of the discriminant,
// so they pin what the CONSUMERS do with the answer and say nothing at all
// about whether the answer is ever produced. Laundering a query error back
// into `{ ok: true, connections: [] }` here silently restores the exact defect
// the seventh state was added to fix: `read_failed` would never fire in
// production, and a PostgREST error would read to a merchant as "you have no
// connections, go and connect one".
//
// Same shape as the server-action gap one layer up: a densely tested consumer
// in front of an untested producer.

/** A query builder whose terminal `.overrideTypes()` resolves to `settled`. */
function queryResolving(settled: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "order"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.overrideTypes = vi.fn(async () => settled);
  return builder;
}

function clientReturning(settled: { data: unknown; error: unknown }) {
  supabaseMock.createClient.mockResolvedValue({ from: vi.fn(() => queryResolving(settled)) });
}

const BUSINESS = "11111111-1111-4111-8111-111111111111";

const ROW = {
  id: "cccccccc-1111-4111-8111-111111111111",
  status: "connected",
  external_account_id: "1001",
  external_account_name: "Kape Cebu",
  scopes: ["pages_show_list", "read_insights"],
  token_expires_at: null,
  last_synced_at: null,
  error: null,
  created_at: "2026-07-26T00:00:00.000Z",
};

describe("readConnections distinguishes a failed read from an empty one", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("CRITICAL: a query error is ok:false, NEVER an empty success", () => {
    // The mutant: `return { ok: true, connections: [] }` here. It restores the
    // defect the seventh state exists to prevent, and no consumer test catches
    // it because every one of them mocks this function.
    clientReturning({ data: null, error: { message: "PostgREST is having a day" } });

    return expect(readConnections(BUSINESS)).resolves.toEqual({ ok: false });
  });

  it("CRITICAL: a successful read of zero rows is ok:true with an empty list", async () => {
    // The pairing half, at the producer. A rule of "no rows means failure"
    // would satisfy the assertion above while telling every genuinely
    // unconnected merchant that the problem is on our side.
    clientReturning({ data: [], error: null });

    await expect(readConnections(BUSINESS)).resolves.toEqual({ ok: true, connections: [] });
  });

  it("CRITICAL: a createClient that THROWS is caught, not propagated", async () => {
    // Not equivalent to the branch above, and the difference is a real screen:
    // `loadIntegrationView` calls `listConnections` with nothing above it to
    // catch, so this is the only thing keeping a thrown createClient off the
    // /business/settings render.
    supabaseMock.createClient.mockRejectedValue(new Error("no cookie store in this scope"));

    await expect(readConnections(BUSINESS)).resolves.toEqual({ ok: false });
  });

  it("maps a returned row into the portal's view shape", async () => {
    clientReturning({ data: [ROW], error: null });

    const result = await readConnections(BUSINESS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connections).toEqual([
      {
        id: "cccccccc-1111-4111-8111-111111111111",
        status: "connected",
        externalAccountId: "1001",
        externalAccountName: "Kape Cebu",
        scopes: ["pages_show_list", "read_insights"],
        tokenExpiresAt: null,
        lastSyncedAt: null,
        error: null,
        connectedAt: "2026-07-26T00:00:00.000Z",
      },
    ]);
  });

  it("treats a null data set with no error as an empty success, not a failure", async () => {
    // PostgREST can answer `{ data: null, error: null }`. It means no rows.
    clientReturning({ data: null, error: null });

    await expect(readConnections(BUSINESS)).resolves.toEqual({ ok: true, connections: [] });
  });

  it("never names a token column in the query it actually runs", async () => {
    // The column fence, exercised through the real call rather than through
    // `assertClientColumns` alone: this asserts the select string the function
    // builds, not the list a test hands it.
    const builder = queryResolving({ data: [], error: null });
    supabaseMock.createClient.mockResolvedValue({ from: vi.fn(() => builder) });

    await readConnections(BUSINESS);

    const selected = String((builder.select as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? "");
    for (const column of TOKEN_COLUMNS) {
      expect(selected).not.toContain(column);
    }
    expect(selected).toContain("external_account_id");
  });
});

describe("listConnections flattens, and loses the distinction on purpose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers [] on a failed read, which is why new callers must not use it", async () => {
    // Pinned so the compromise is visible rather than implied. This is the
    // shape `loadIntegrationView` still depends on, and the reason the
    // settings card cannot yet tell an empty read from a failed one.
    clientReturning({ data: null, error: { message: "PostgREST is having a day" } });

    await expect(listConnections(BUSINESS)).resolves.toEqual([]);
  });

  it("answers the same [] on a genuinely empty read", async () => {
    clientReturning({ data: [], error: null });

    await expect(listConnections(BUSINESS)).resolves.toEqual([]);
  });
});

