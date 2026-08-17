// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// The publish path, and the permission it is not allowed to assume it has.
// =============================================================================
//
// `publishFacebookPost` needs `pages_manage_posts`. Adding that scope to
// META_V1_SCOPES made the consent dialog ASK for it; it did not make any
// particular merchant HOLD it. Everything below is about the gap between those
// two, because the gap is where "a button that fails every time" lives.
//
// THESE TESTS DO NOT NEED A META APP. The unconfigured refusal and the
// unscoped refusal are the two paths that ship first, so they carry the most
// assertions and their exact prose is pinned with full-string `toBe`.

vi.mock("server-only", () => ({}));

const serverEnv: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => serverEnv }));

const cipherMock = vi.hoisted(() => ({ isTokenCipherConfigured: vi.fn(() => true) }));
vi.mock("@/lib/crypto/token-cipher", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/crypto/token-cipher")>("@/lib/crypto/token-cipher");
  return { ...actual, isTokenCipherConfigured: cipherMock.isTokenCipherConfigured };
});

const metaMock = vi.hoisted(() => ({ publishFacebookPost: vi.fn() }));
vi.mock("@/lib/integrations/meta", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/integrations/meta")>("@/lib/integrations/meta");
  return { ...actual, publishFacebookPost: metaMock.publishFacebookPost };
});

const capabilityMock = vi.hoisted(() => ({ readGrantedScopes: vi.fn() }));
vi.mock("./capability", () => capabilityMock);

const tokensMock = vi.hoisted(() => ({ withPageToken: vi.fn() }));
vi.mock("./tokens", () => tokensMock);

const repoMock = vi.hoisted(() => ({ readConnectionSecret: vi.fn() }));
vi.mock("./repo", () => repoMock);

const auditMock = vi.hoisted(() => ({
  recordConnectionChange: vi.fn(),
  AUDIT_ACTIONS: {
    connected: "integration.connected",
    disconnected: "integration.disconnected",
    revoked: "integration.revoked",
    expired: "integration.expired",
    published: "integration.published",
  },
}));
vi.mock("./audit", () => auditMock);

import { MetaError } from "@/lib/integrations/meta";

import { publishCampaignToMeta } from "./publishing";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "cccccccc-1111-4111-8111-111111111111";
const ACTOR = "22222222-1111-4111-8111-111111111111";

/**
 * Written out by hand, not sliced off META_V1_SCOPES.
 *
 * This is what Meta grants an ordinary merchant while the app is unreviewed,
 * and the only job of this fixture is to be able to disagree with the constant
 * the OAuth dialog is built from.
 */
const READ_ONLY_GRANT = ["pages_show_list", "pages_read_engagement", "read_insights"];
const TESTER_GRANT = [...READ_ONLY_GRANT, "pages_manage_posts"];

function input(overrides: Record<string, unknown> = {}) {
  return {
    businessId: BUSINESS,
    connectionId: CONNECTION,
    actorId: ACTOR,
    actorRole: "owner",
    message: "Double points all weekend at Kape Cebu.",
    linkUrl: "https://giya.ph/b/kape-cebu",
    ...overrides,
  } as Parameters<typeof publishCampaignToMeta>[0];
}

function tokenWorks(): void {
  tokensMock.withPageToken.mockImplementation(
    async (_i: unknown, run: (token: string) => Promise<unknown>) => ({
      ok: true,
      data: await run("EAAGlive-page-token"),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  serverEnv.META_APP_ID = "1234567890";
  serverEnv.META_APP_SECRET = "test-app-secret-value";
  cipherMock.isTokenCipherConfigured.mockReturnValue(true);
  repoMock.readConnectionSecret.mockResolvedValue({
    id: CONNECTION,
    status: "connected",
    externalAccountId: "1001",
    accessTokenEncrypted: Buffer.from("ciphertext"),
    tokenExpiresAt: null,
    updatedAt: new Date().toISOString(),
  });
  capabilityMock.readGrantedScopes.mockResolvedValue({ ok: true, scopes: TESTER_GRANT });
  metaMock.publishFacebookPost.mockResolvedValue({ id: "1001_9999" });
  auditMock.recordConnectionChange.mockResolvedValue({ ok: true });
  tokenWorks();
});

describe("publishing refuses before it reaches Meta", () => {
  it("refuses on a deployment with no Meta credentials, in the surface's own words", async () => {
    delete serverEnv.META_APP_ID;
    delete serverEnv.META_APP_SECRET;

    const result = await publishCampaignToMeta(input());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      "Posting to a Facebook Page is not available on this deployment yet.",
    );
    expect(metaMock.publishFacebookPost).not.toHaveBeenCalled();
  });

  it("refuses with a DIFFERENT sentence when only token storage is unconfigured", async () => {
    cipherMock.isTokenCipherConfigured.mockReturnValue(false);

    const result = await publishCampaignToMeta(input());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      "Posting to a Facebook Page is not available yet: secure credential storage is not configured.",
    );
    expect(metaMock.publishFacebookPost).not.toHaveBeenCalled();
  });

  it("refuses when the connection id names nothing in this tenant", async () => {
    repoMock.readConnectionSecret.mockResolvedValue(null);

    const result = await publishCampaignToMeta(input());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      "Connect a Facebook Page in Settings before posting a campaign announcement.",
    );
    expect(metaMock.publishFacebookPost).not.toHaveBeenCalled();
  });

  it("refuses on an expired connection and names reconnecting as the fix", async () => {
    repoMock.readConnectionSecret.mockResolvedValue({
      id: CONNECTION,
      status: "expired",
      externalAccountId: "1001",
      accessTokenEncrypted: Buffer.from("ciphertext"),
      tokenExpiresAt: null,
      updatedAt: new Date().toISOString(),
    });

    const result = await publishCampaignToMeta(input());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      "The access we were given has ended. Reconnect this Page in Settings before posting.",
    );
    expect(metaMock.publishFacebookPost).not.toHaveBeenCalled();
  });
});

describe("THE SCOPE GATE (G2 section 2)", () => {
  it("CRITICAL: refuses when the TOKEN does not carry pages_manage_posts", async () => {
    // META_V1_SCOPES contains pages_manage_posts. A gate on the constant would
    // sail past this and hand the merchant a request Meta refuses, on a
    // permission they were never granted.
    capabilityMock.readGrantedScopes.mockResolvedValue({ ok: true, scopes: READ_ONLY_GRANT });

    const result = await publishCampaignToMeta(input());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Pinned in full. This sentence makes a claim about WHY, and half of it
    // (that nothing is wrong on the merchant's side) is the half a paraphrase
    // would quietly drop.
    expect(result.message).toBe(
      "Posting needs a Facebook permission this app has not been approved for yet. Nothing is wrong with your Page or your account.",
    );
    // The whole point: the call is never made.
    expect(metaMock.publishFacebookPost).not.toHaveBeenCalled();
  });

  it("CRITICAL: publishes when the token DOES carry pages_manage_posts", async () => {
    // The pairing case. A gate hard-wired to refuse would satisfy the
    // assertion above while making the feature unreachable for the tester
    // account it was built for.
    const result = await publishCampaignToMeta(input());

    expect(result).toEqual({ ok: true, postId: "1001_9999" });
    expect(metaMock.publishFacebookPost).toHaveBeenCalledTimes(1);
    expect(metaMock.publishFacebookPost.mock.calls[0]?.[0]).toMatchObject({
      pageId: "1001",
      message: "Double points all weekend at Kape Cebu.",
      link: "https://giya.ph/b/kape-cebu",
    });
  });

  it("asks about the scope through the capability module, not the row", async () => {
    await publishCampaignToMeta(input());
    expect(capabilityMock.readGrantedScopes).toHaveBeenCalledWith(BUSINESS, CONNECTION);
  });

  it("refuses without claiming a missing permission when Meta could not be asked", async () => {
    capabilityMock.readGrantedScopes.mockResolvedValue({ ok: false, failure: "unavailable" });

    const result = await publishCampaignToMeta(input());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      "Facebook is not responding right now, so posting is paused. Please try again in a few minutes.",
    );
    expect(metaMock.publishFacebookPost).not.toHaveBeenCalled();
  });

  it("refuses without offering reconnect when the credential cannot be opened", async () => {
    capabilityMock.readGrantedScopes.mockResolvedValue({ ok: false, failure: "unreadable" });

    const result = await publishCampaignToMeta(input());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      "Giya cannot open the stored credential for this Page. This one is ours to fix, and reconnecting will not help.",
    );
  });
});

describe("publishing never leaks a provider message or a token", () => {
  it("answers in our own words when Meta rejects the post", async () => {
    tokenWorks();
    metaMock.publishFacebookPost.mockRejectedValue(
      // A real Meta rejection shape. The code is spelled `(#10)` rather than
      // the more typical `(#100)` for a boring reason worth recording: the
      // repo's design-system lint bans raw hex colours in src/, and `#100` is
      // three hex digits.
      new MetaError("META_BAD_REQUEST", "(#10) Application does not have permission", {
        retryable: false,
        status: 403,
        providerCode: 10,
      }),
    );

    const result = await publishCampaignToMeta(input());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("That post could not be published. Please try again.");
    // Meta's own body echoes request context, and the request carried a token.
    expect(result.message).not.toContain("(#10)");
    expect(result.message).not.toContain("does not have permission");
  });

  it("does not put an unexpected exception's message in front of the merchant", async () => {
    tokenWorks();
    metaMock.publishFacebookPost.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.1:443 token=EAAGsecret"),
    );

    const result = await publishCampaignToMeta(input());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("That post could not be published. Please try again.");
    expect(result.message).not.toContain("EAAGsecret");
  });

  it("reads the page token through tokens.ts rather than decrypting inline", async () => {
    // tokens.ts documents itself as the only module that opens a stored
    // credential, and routing through it is also what keeps refresh-on-read on
    // the publish path. A token 46 days old would otherwise be posted with.
    await publishCampaignToMeta(input());
    expect(tokensMock.withPageToken).toHaveBeenCalledWith(
      { connectionId: CONNECTION, businessId: BUSINESS },
      expect.any(Function),
    );
  });

  it("reports the refresh-on-read expiry honestly instead of publishing anyway", async () => {
    tokensMock.withPageToken.mockResolvedValue({ ok: false, failure: "expired" });

    const result = await publishCampaignToMeta(input());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      "The access we were given has ended. Reconnect this Page in Settings before posting.",
    );
  });
});

describe("publishing is audited, without the post's credential", () => {
  it("records the publish against the connection", async () => {
    await publishCampaignToMeta(input());

    expect(auditMock.recordConnectionChange).toHaveBeenCalledTimes(1);
    const row = auditMock.recordConnectionChange.mock.calls[0]?.[0];
    expect(row).toMatchObject({
      action: "integration.published",
      businessId: BUSINESS,
      connectionId: CONNECTION,
      actorId: ACTOR,
      actorKind: "user",
      actorRole: "owner",
    });
    expect(JSON.stringify(row)).not.toContain("EAAGlive-page-token");
  });

  it("does not audit a publish that never happened", async () => {
    capabilityMock.readGrantedScopes.mockResolvedValue({ ok: true, scopes: READ_ONLY_GRANT });

    await publishCampaignToMeta(input());
    expect(auditMock.recordConnectionChange).not.toHaveBeenCalled();
  });
});
