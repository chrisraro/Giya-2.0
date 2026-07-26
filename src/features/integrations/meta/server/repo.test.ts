// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));

import { CLIENT_COLUMNS, TOKEN_COLUMNS, assertClientColumns } from "./repo";

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
