// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const serverEnv: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => serverEnv }));

const repoMock = vi.hoisted(() => ({
  readConnectionSecret: vi.fn(),
  updateConnectionToken: vi.fn(),
  markStatus: vi.fn(),
}));
vi.mock("./repo", () => repoMock);

const auditMock = vi.hoisted(() => ({
  recordConnectionChange: vi.fn(),
  AUDIT_ACTIONS: {
    connected: "integration.connected",
    disconnected: "integration.disconnected",
    revoked: "integration.revoked",
    expired: "integration.expired",
  },
}));
vi.mock("./audit", () => auditMock);

const metaMock = vi.hoisted(() => ({ exchangeForLongLivedToken: vi.fn() }));
vi.mock("@/lib/integrations/meta", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/meta")>(
    "@/lib/integrations/meta",
  );
  return { ...actual, exchangeForLongLivedToken: metaMock.exchangeForLongLivedToken };
});

import { encryptToken } from "@/lib/crypto/token-cipher";
import { MetaError } from "@/lib/integrations/meta";

import { REFRESH_AFTER_DAYS, withPageToken } from "./tokens";

const CONNECTION = "cccccccc-1111-4111-8111-111111111111";
const BUSINESS = "11111111-1111-4111-8111-111111111111";
const STORED_TOKEN = "EAAGstored-page-token";
const FRESH_TOKEN = "EAAGfreshly-exchanged-token";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function connectionRow(updatedAt: string, token = STORED_TOKEN) {
  return {
    id: CONNECTION,
    status: "connected",
    externalAccountId: "1001",
    accessTokenEncrypted: encryptToken(token),
    tokenExpiresAt: null,
    updatedAt,
  };
}

beforeEach(() => {
  serverEnv.META_APP_ID = "1234567890";
  serverEnv.META_APP_SECRET = "test-secret";
  process.env.INTEGRATION_TOKEN_AES_KEY = Buffer.alloc(32, 4).toString("base64");

  repoMock.readConnectionSecret.mockReset();
  repoMock.updateConnectionToken.mockReset().mockResolvedValue({ ok: true, data: null });
  repoMock.markStatus.mockReset().mockResolvedValue({ ok: true, data: null });
  auditMock.recordConnectionChange.mockReset().mockResolvedValue({ ok: true });
  metaMock.exchangeForLongLivedToken.mockReset();

  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("refresh-on-read", () => {
  it("uses doc 42's 45-day threshold", () => {
    expect(REFRESH_AFTER_DAYS).toBe(45);
  });

  it("does NOT refresh a token younger than 45 days", async () => {
    repoMock.readConnectionSecret.mockResolvedValue(connectionRow(daysAgo(44)));

    const result = await withPageToken(
      { connectionId: CONNECTION, businessId: BUSINESS },
      async (token) => token,
    );

    expect(result).toEqual({ ok: true, data: STORED_TOKEN });
    expect(metaMock.exchangeForLongLivedToken).not.toHaveBeenCalled();
  });

  it("refreshes a token at or past 45 days, BEFORE the caller uses it", async () => {
    // The ordering is the point of "refresh on read": a token refreshed
    // reactively (call, fail, refresh, retry) turns every expiry into at least
    // one user-visible error.
    repoMock.readConnectionSecret.mockResolvedValue(connectionRow(daysAgo(46)));
    metaMock.exchangeForLongLivedToken.mockResolvedValue({
      accessToken: FRESH_TOKEN,
      expiresAt: new Date("2026-09-30T00:00:00Z"),
    });

    const result = await withPageToken(
      { connectionId: CONNECTION, businessId: BUSINESS },
      async (token) => token,
    );

    expect(result).toEqual({ ok: true, data: FRESH_TOKEN });
    expect(metaMock.exchangeForLongLivedToken).toHaveBeenCalledWith({
      accessToken: STORED_TOKEN,
    });
  });

  it("stores the refreshed token through the token-only UPDATE", async () => {
    // NOT through the connect upsert: that would rewrite the whole row and
    // erase the Page name and the granted scopes, which the refresh path does
    // not know. This assertion is the guard on that.
    repoMock.readConnectionSecret.mockResolvedValue(connectionRow(daysAgo(50)));
    metaMock.exchangeForLongLivedToken.mockResolvedValue({
      accessToken: FRESH_TOKEN,
      expiresAt: null,
    });

    await withPageToken({ connectionId: CONNECTION, businessId: BUSINESS }, async () => null);

    expect(repoMock.updateConnectionToken).toHaveBeenCalledWith({
      connectionId: CONNECTION,
      businessId: BUSINESS,
      accessToken: FRESH_TOKEN,
      tokenExpiresAt: null,
    });
  });

  it("still serves the read when Meta is merely unreachable", async () => {
    // The stored token is very likely valid for another fifteen days.
    // Refusing would convert a transient Meta outage into a broken integration.
    repoMock.readConnectionSecret.mockResolvedValue(connectionRow(daysAgo(50)));
    metaMock.exchangeForLongLivedToken.mockRejectedValue(
      new MetaError("META_UNAVAILABLE", "down", { retryable: true }),
    );

    const result = await withPageToken(
      { connectionId: CONNECTION, businessId: BUSINESS },
      async (token) => token,
    );

    expect(result).toEqual({ ok: true, data: STORED_TOKEN });
    expect(repoMock.markStatus).not.toHaveBeenCalled();
  });

  it("flips the connection to 'expired' only when Meta rejects the token itself", async () => {
    repoMock.readConnectionSecret.mockResolvedValue(connectionRow(daysAgo(50)));
    metaMock.exchangeForLongLivedToken.mockRejectedValue(
      new MetaError("META_AUTH_FAILED", "dead", { retryable: false }),
    );

    const result = await withPageToken(
      { connectionId: CONNECTION, businessId: BUSINESS },
      async (token) => token,
    );

    expect(result).toEqual({ ok: false, failure: "expired" });
    expect(repoMock.markStatus).toHaveBeenCalledWith({
      connectionId: CONNECTION,
      status: "expired",
      actorId: null,
    });
  });

  it("audits the expiry as a system action", async () => {
    repoMock.readConnectionSecret.mockResolvedValue(connectionRow(daysAgo(50)));
    metaMock.exchangeForLongLivedToken.mockRejectedValue(
      new MetaError("META_AUTH_FAILED", "dead", { retryable: false }),
    );

    await withPageToken({ connectionId: CONNECTION, businessId: BUSINESS }, async () => null);

    expect(auditMock.recordConnectionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "integration.expired",
        actorKind: "system",
        actorId: null,
        businessId: BUSINESS,
      }),
    );
  });
});

describe("token handling", () => {
  it("reports not_found rather than throwing for a missing connection", async () => {
    repoMock.readConnectionSecret.mockResolvedValue(null);
    await expect(
      withPageToken({ connectionId: CONNECTION, businessId: BUSINESS }, async () => null),
    ).resolves.toEqual({ ok: false, failure: "not_found" });
  });

  it("reports undecryptable and leaves the connection alone", async () => {
    // An undecryptable row is an operations problem (a key removed from the
    // registry too early). Flipping it to 'expired' would tell the merchant to
    // reconnect over something reconnecting cannot fix.
    repoMock.readConnectionSecret.mockResolvedValue({
      ...connectionRow(daysAgo(1)),
      accessTokenEncrypted: Buffer.from([9, 9, 9, 9]),
    });

    await expect(
      withPageToken({ connectionId: CONNECTION, businessId: BUSINESS }, async () => null),
    ).resolves.toEqual({ ok: false, failure: "undecryptable" });
    expect(repoMock.markStatus).not.toHaveBeenCalled();
  });

  it("NEVER LOGS A TOKEN, on any path", async () => {
    // The constraint the whole slice is judged on, asserted across the three
    // paths that hold a decrypted token in memory.
    repoMock.readConnectionSecret.mockResolvedValue(connectionRow(daysAgo(50)));
    metaMock.exchangeForLongLivedToken.mockRejectedValue(
      new MetaError("META_UNAVAILABLE", "down", { retryable: true }),
    );
    await withPageToken({ connectionId: CONNECTION, businessId: BUSINESS }, async () => null);

    metaMock.exchangeForLongLivedToken.mockRejectedValue(
      new MetaError("META_AUTH_FAILED", "dead", { retryable: false }),
    );
    await withPageToken({ connectionId: CONNECTION, businessId: BUSINESS }, async () => null);

    repoMock.readConnectionSecret.mockResolvedValue({
      ...connectionRow(daysAgo(1)),
      accessTokenEncrypted: Buffer.from([9, 9, 9, 9]),
    });
    await withPageToken({ connectionId: CONNECTION, businessId: BUSINESS }, async () => null);

    const logged = [
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ]
      .flat()
      .map((entry) => String(entry))
      .join(" ");

    expect(logged).not.toContain(STORED_TOKEN);
    expect(logged).not.toContain(FRESH_TOKEN);
  });

  it("NEVER PUTS A TOKEN IN AN AUDIT ROW", async () => {
    // 0022 grants before/after to the tenant owner, so anything there is
    // published to that tenant.
    repoMock.readConnectionSecret.mockResolvedValue(connectionRow(daysAgo(50)));
    metaMock.exchangeForLongLivedToken.mockRejectedValue(
      new MetaError("META_AUTH_FAILED", "dead", { retryable: false }),
    );

    await withPageToken({ connectionId: CONNECTION, businessId: BUSINESS }, async () => null);

    const audited = JSON.stringify(auditMock.recordConnectionChange.mock.calls);
    expect(audited).not.toContain(STORED_TOKEN);
    expect(audited).not.toContain("access_token");
  });

  it("hands the token to exactly one callback and returns its result, not the token", async () => {
    repoMock.readConnectionSecret.mockResolvedValue(connectionRow(daysAgo(1)));

    const seen: string[] = [];
    const result = await withPageToken(
      { connectionId: CONNECTION, businessId: BUSINESS },
      async (token) => {
        seen.push(token);
        return { impressions: 120 };
      },
    );

    expect(seen).toEqual([STORED_TOKEN]);
    // The success shape carries the CALLER'S value. There is no path by which
    // `withPageToken` returns the credential itself.
    expect(result).toEqual({ ok: true, data: { impressions: 120 } });
    expect(JSON.stringify(result)).not.toContain(STORED_TOKEN);
  });
});
