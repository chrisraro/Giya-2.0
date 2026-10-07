// @vitest-environment node
//
// The authorize request and the token exchange must send a BYTE-IDENTICAL
// redirect_uri (Meta rejects the exchange otherwise), and that URI must be the
// one static, registrable path - no business id in it.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const meta = vi.hoisted(() => ({ buildAuthorizeUrl: vi.fn() }));
vi.mock("@/lib/integrations/meta", () => ({
  MetaError: class MetaError extends Error {},
  buildAuthorizeUrl: (...a: unknown[]) => meta.buildAuthorizeUrl(...a),
  debugToken: vi.fn(),
  exchangeCodeForToken: vi.fn(),
  exchangeForLongLivedToken: vi.fn(),
  isMetaConfigured: () => true,
  listPages: vi.fn(),
  revokePermissions: vi.fn(),
}));
vi.mock("@/lib/crypto/token-cipher", () => ({
  decryptToken: vi.fn(),
  isTokenCipherConfigured: () => true,
}));
vi.mock("./audit", () => ({ AUDIT_ACTIONS: {}, recordConnectionChange: vi.fn() }));
vi.mock("./repo", () => ({}));
vi.mock("./selection", () => ({
  consumeSelection: vi.fn(),
  peekSelectablePages: vi.fn(),
  storePendingSelection: vi.fn(),
}));

const issued = vi.hoisted(() => ({ issueState: vi.fn() }));
vi.mock("./state", () => ({ issueState: (...a: unknown[]) => issued.issueState(...a) }));

import { callbackUrl, startConnect } from "./service";

const ORIGIN = "https://www.giya.ph";
const STATIC_URI = "https://www.giya.ph/api/v1/integrations/meta/callback";

beforeEach(() => {
  issued.issueState.mockReset().mockResolvedValue("state-nonce");
  meta.buildAuthorizeUrl.mockReset().mockReturnValue("https://facebook.test/dialog");
});

describe("callbackUrl", () => {
  it("is one static path with no business in it", () => {
    expect(callbackUrl(ORIGIN)).toBe(STATIC_URI);
  });
});

describe("startConnect", () => {
  it("uses the same static redirect_uri for the stored state and the authorize URL", async () => {
    const result = await startConnect({ businessId: "biz-1", userId: "user-1", origin: ORIGIN });

    expect(result.ok).toBe(true);
    expect(issued.issueState).toHaveBeenCalledWith({
      businessId: "biz-1",
      userId: "user-1",
      redirectUri: STATIC_URI,
    });
    expect(meta.buildAuthorizeUrl).toHaveBeenCalledWith({
      redirectUri: STATIC_URI,
      state: "state-nonce",
    });
  });

  it("gives every business the identical redirect_uri", async () => {
    await startConnect({ businessId: "biz-1", userId: "u", origin: ORIGIN });
    await startConnect({ businessId: "biz-2", userId: "u", origin: ORIGIN });

    const uris = meta.buildAuthorizeUrl.mock.calls.map((c) => (c[0] as { redirectUri: string }).redirectUri);
    expect(new Set(uris)).toEqual(new Set([STATIC_URI]));
  });
});
