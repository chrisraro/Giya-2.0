// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// THE SCOPE GATE. This is the crux of G2 and the reason the module exists.
// =============================================================================
//
// `publishFacebookPost` needs `pages_manage_posts`. That scope is now in
// META_V1_SCOPES, so the consent dialog ASKS for it. Asking is not holding:
//
//   - a merchant can untick an individual permission on Meta's consent screen;
//   - an app that has not passed App Review grants an unreviewed scope only to
//     users who are admins, developers or testers of that app, and silently
//     grants a shorter list to everyone else.
//
// So the affordance is gated on `GET /debug_token`, which reports what the
// TOKEN carries. Every test below that pins `scope_missing` is pinning the
// difference between the requested list and the granted list, and the named
// mutant for all of them is the same one: gate on META_V1_SCOPES instead.
//
// NOTHING HERE NEEDS A LIVE META APP, and that is the point. The paths that
// ship first are the unconfigured one and the unscoped one, so those are the
// ones with the most assertions on them.

vi.mock("server-only", () => ({}));

const serverEnv: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => serverEnv }));

const cipherMock = vi.hoisted(() => ({ isTokenCipherConfigured: vi.fn(() => true) }));
vi.mock("@/lib/crypto/token-cipher", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/crypto/token-cipher")>("@/lib/crypto/token-cipher");
  return { ...actual, isTokenCipherConfigured: cipherMock.isTokenCipherConfigured };
});

const metaMock = vi.hoisted(() => ({ debugToken: vi.fn() }));
vi.mock("@/lib/integrations/meta", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/integrations/meta")>("@/lib/integrations/meta");
  return { ...actual, debugToken: metaMock.debugToken };
});

const tokensMock = vi.hoisted(() => ({ withPageToken: vi.fn() }));
vi.mock("./tokens", () => tokensMock);

const repoMock = vi.hoisted(() => ({ listConnections: vi.fn() }));
vi.mock("./repo", () => repoMock);

import { MetaError } from "@/lib/integrations/meta";

import type { MetaConnectionView } from "../types";
import { loadPublishView, readGrantedScopes } from "./capability";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "cccccccc-1111-4111-8111-111111111111";

/**
 * The four read scopes and NOT the publish one, written out by hand.
 *
 * This is what an ordinary merchant's token looks like while the app is
 * unreviewed. It is a literal rather than a slice of META_V1_SCOPES, because a
 * list derived from the constant could never disagree with it, and disagreeing
 * with it is the only thing this fixture is for.
 */
const READ_ONLY_GRANT = [
  "pages_show_list",
  "pages_read_engagement",
  "read_insights",
  "instagram_basic",
] as const;

/** What an app admin, developer or tester is granted today. */
const TESTER_GRANT = [...READ_ONLY_GRANT, "pages_manage_posts"] as const;

function connection(overrides: Partial<MetaConnectionView> = {}): MetaConnectionView {
  return {
    id: CONNECTION,
    status: "connected",
    externalAccountId: "1001",
    externalAccountName: "Kape Cebu",
    scopes: [...TESTER_GRANT],
    tokenExpiresAt: null,
    lastSyncedAt: null,
    error: null,
    connectedAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

/** `withPageToken` hands a live token to its callback. Run it for real. */
function tokenWorks(): void {
  tokensMock.withPageToken.mockImplementation(
    async (_input: unknown, run: (token: string) => Promise<unknown>) => ({
      ok: true,
      data: await run("EAAGlive-page-token"),
    }),
  );
}

function grants(scopes: readonly string[]): void {
  tokenWorks();
  metaMock.debugToken.mockResolvedValue({ isValid: true, scopes: [...scopes], expiresAt: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  serverEnv.META_APP_ID = "1234567890";
  serverEnv.META_APP_SECRET = "test-app-secret-value";
  cipherMock.isTokenCipherConfigured.mockReturnValue(true);
  repoMock.listConnections.mockResolvedValue([connection()]);
  grants(TESTER_GRANT);
});

describe("readGrantedScopes reports what the TOKEN carries", () => {
  it("returns the granted list Meta reports, not the list we asked for", async () => {
    grants(READ_ONLY_GRANT);

    const result = await readGrantedScopes(BUSINESS, CONNECTION);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.scopes]).toEqual([
      "pages_show_list",
      "pages_read_engagement",
      "read_insights",
      "instagram_basic",
    ]);
    // The requested list is longer. If this module ever answered with the
    // request rather than the grant, this is the line that catches it.
    expect([...result.scopes]).not.toContain("pages_manage_posts");
  });

  it("reads through withPageToken, so refresh-on-read still happens", async () => {
    await readGrantedScopes(BUSINESS, CONNECTION);
    expect(tokensMock.withPageToken).toHaveBeenCalledTimes(1);
    expect(tokensMock.withPageToken.mock.calls[0]?.[0]).toEqual({
      businessId: BUSINESS,
      connectionId: CONNECTION,
    });
  });

  it("says needs_reconnect when Meta rejects the stored token", async () => {
    tokensMock.withPageToken.mockResolvedValue({ ok: false, failure: "expired" });

    const result = await readGrantedScopes(BUSINESS, CONNECTION);
    expect(result).toEqual({ ok: false, failure: "needs_reconnect" });
  });

  it("says needs_reconnect when debug_token answers is_valid false", async () => {
    tokenWorks();
    metaMock.debugToken.mockResolvedValue({ isValid: false, scopes: [], expiresAt: null });

    const result = await readGrantedScopes(BUSINESS, CONNECTION);
    // NOT "scope_missing" with an empty list. A dead token tells us nothing
    // about scopes, and reporting it as a missing permission would send the
    // merchant to a support conversation they cannot win.
    expect(result).toEqual({ ok: false, failure: "needs_reconnect" });
  });

  it("says unavailable when the circuit is open, and claims nothing about scopes", async () => {
    tokenWorks();
    metaMock.debugToken.mockRejectedValue(
      new MetaError("META_CIRCUIT_OPEN", "The Meta integration is temporarily unavailable.", {
        retryable: true,
      }),
    );

    const result = await readGrantedScopes(BUSINESS, CONNECTION);
    expect(result).toEqual({ ok: false, failure: "unavailable" });
  });

  it("says unreadable when this build cannot open the stored credential", async () => {
    tokensMock.withPageToken.mockResolvedValue({ ok: false, failure: "undecryptable" });

    const result = await readGrantedScopes(BUSINESS, CONNECTION);
    // Distinct from needs_reconnect on purpose: reconnecting cannot fix a key
    // that was rotated away, so the surface must not offer it as the remedy.
    expect(result).toEqual({ ok: false, failure: "unreadable" });
  });

  it("never throws, whatever comes back from the boundary", async () => {
    tokenWorks();
    metaMock.debugToken.mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      readGrantedScopes(BUSINESS, CONNECTION),
    ).resolves.toEqual({ ok: false, failure: "unavailable" });
  });

  it("does not call Meta at all when the integration is not configured", async () => {
    delete serverEnv.META_APP_ID;
    delete serverEnv.META_APP_SECRET;

    const result = await readGrantedScopes(BUSINESS, CONNECTION);
    expect(result).toEqual({ ok: false, failure: "unavailable" });
    expect(tokensMock.withPageToken).not.toHaveBeenCalled();
    expect(metaMock.debugToken).not.toHaveBeenCalled();
  });
});

describe("loadPublishView degrades honestly before it looks at any Page", () => {
  it("reports not_configured when this deployment has no Meta credentials", async () => {
    delete serverEnv.META_APP_ID;
    delete serverEnv.META_APP_SECRET;

    const view = await loadPublishView({ businessId: BUSINESS, canManage: true });
    expect(view.state).toBe("not_configured");
    expect(view.pages).toEqual([]);
    expect(metaMock.debugToken).not.toHaveBeenCalled();
  });

  it("reports storage_unavailable separately from not_configured", async () => {
    // A different missing variable with a different fix. Collapsing the two
    // produces a support ticket nobody can act on.
    cipherMock.isTokenCipherConfigured.mockReturnValue(false);

    const view = await loadPublishView({ businessId: BUSINESS, canManage: true });
    expect(view.state).toBe("storage_unavailable");
    expect(view.pages).toEqual([]);
  });

  it("reports not_connected when the tenant has connected no Page", async () => {
    repoMock.listConnections.mockResolvedValue([]);

    const view = await loadPublishView({ businessId: BUSINESS, canManage: true });
    expect(view.state).toBe("not_connected");
    expect(view.pages).toEqual([]);
  });
});

describe("loadPublishView gates on the GRANT, never on the request", () => {
  it("CRITICAL: a token without pages_manage_posts is scope_missing", async () => {
    // The whole brief in one assertion. META_V1_SCOPES contains
    // pages_manage_posts, so a gate written against the constant would answer
    // 'ready' here and hand the merchant a button that fails every time.
    grants(READ_ONLY_GRANT);

    const view = await loadPublishView({ businessId: BUSINESS, canManage: true });

    expect(view.state).toBe("pages");
    expect(view.pages).toEqual([
      { connectionId: CONNECTION, pageName: "Kape Cebu", capability: "scope_missing" },
    ]);
  });

  it("CRITICAL: a token WITH pages_manage_posts is ready", async () => {
    // The pairing case. Without it, a gate hard-wired to 'scope_missing' would
    // pass the assertion above while making the feature unreachable for the
    // tester account it was built for.
    grants(TESTER_GRANT);

    const view = await loadPublishView({ businessId: BUSINESS, canManage: true });

    expect(view.pages).toEqual([
      { connectionId: CONNECTION, pageName: "Kape Cebu", capability: "ready" },
    ]);
  });

  it("ignores the scopes recorded on the ROW when the token says otherwise", async () => {
    // `integration_connections.scopes` is a snapshot from connect time. A
    // merchant who removed the permission in Facebook's own settings still has
    // the old list on their row, and trusting it would show a working button
    // over a dead permission.
    repoMock.listConnections.mockResolvedValue([connection({ scopes: [...TESTER_GRANT] })]);
    grants(READ_ONLY_GRANT);

    const view = await loadPublishView({ businessId: BUSINESS, canManage: true });
    expect(view.pages[0]?.capability).toBe("scope_missing");
  });

  it("reports each Page separately when they disagree", async () => {
    repoMock.listConnections.mockResolvedValue([
      connection({ id: "aaaaaaaa-1111-4111-8111-111111111111", externalAccountName: "Kape Cebu" }),
      connection({ id: "bbbbbbbb-1111-4111-8111-111111111111", externalAccountName: "Kape Manila" }),
    ]);
    tokenWorks();
    metaMock.debugToken
      .mockResolvedValueOnce({ isValid: true, scopes: [...TESTER_GRANT], expiresAt: null })
      .mockResolvedValueOnce({ isValid: true, scopes: [...READ_ONLY_GRANT], expiresAt: null });

    const view = await loadPublishView({ businessId: BUSINESS, canManage: true });

    expect(view.pages).toEqual([
      {
        connectionId: "aaaaaaaa-1111-4111-8111-111111111111",
        pageName: "Kape Cebu",
        capability: "ready",
      },
      {
        connectionId: "bbbbbbbb-1111-4111-8111-111111111111",
        pageName: "Kape Manila",
        capability: "scope_missing",
      },
    ]);
  });

  it("does not ask Meta about an expired connection", async () => {
    // The row already says the grant is dead. Spending a Graph call and a
    // circuit-breaker failure to be told so again would be the read that takes
    // the integration down for everyone else.
    repoMock.listConnections.mockResolvedValue([connection({ status: "expired" })]);

    const view = await loadPublishView({ businessId: BUSINESS, canManage: true });

    expect(view.pages[0]?.capability).toBe("needs_reconnect");
    expect(metaMock.debugToken).not.toHaveBeenCalled();
  });

  it("does not ask Meta about a revoked connection either", async () => {
    repoMock.listConnections.mockResolvedValue([connection({ status: "revoked" })]);

    const view = await loadPublishView({ businessId: BUSINESS, canManage: true });

    expect(view.pages[0]?.capability).toBe("needs_reconnect");
    expect(metaMock.debugToken).not.toHaveBeenCalled();
  });

  it("reports unavailable rather than guessing when Meta cannot be reached", async () => {
    tokenWorks();
    metaMock.debugToken.mockRejectedValue(
      new MetaError("META_TIMEOUT", "Meta did not respond within 10000ms.", { retryable: true }),
    );

    const view = await loadPublishView({ businessId: BUSINESS, canManage: true });
    // Not scope_missing. We asked and got no answer; claiming a permission is
    // absent on that basis is inventing a fact about the merchant's account.
    expect(view.pages[0]?.capability).toBe("unavailable");
  });

  it("falls back to the Page id when Meta never gave us a name", async () => {
    repoMock.listConnections.mockResolvedValue([connection({ externalAccountName: null })]);

    const view = await loadPublishView({ businessId: BUSINESS, canManage: true });
    expect(view.pages[0]?.pageName).toBe("1001");
  });

  it("carries canManage through untouched", async () => {
    const view = await loadPublishView({ businessId: BUSINESS, canManage: false });
    expect(view.canManage).toBe(false);
  });

  it("never throws when the connection read itself fails", async () => {
    repoMock.listConnections.mockRejectedValue(new Error("PostgREST is having a day"));

    // doc 42: "never blocks core loops". This runs inside a page render.
    await expect(loadPublishView({ businessId: BUSINESS, canManage: true })).resolves.toEqual({
      state: "not_connected",
      pages: [],
      canManage: true,
    });
  });
});
