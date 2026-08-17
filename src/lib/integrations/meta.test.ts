// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// `src/lib/env.ts` validates NEXT_PUBLIC_* at MODULE scope and throws without
// them, so it is stubbed here exactly as the OCR provider suite stubs it. The
// mutable object is also how the dormant-versus-configured cases are driven.
const serverEnv: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({
  env: {},
  getServerEnv: () => serverEnv,
}));

// The breaker has its own suite; here it is stubbed to a pass-through so a
// failing-request test does not have to reason about circuit state. The one
// behaviour that IS asserted below is the translation of CircuitOpenError into
// META_CIRCUIT_OPEN, which is this module's job rather than the breaker's.
const breaker = vi.hoisted(() => ({
  open: { value: false },
  captured: { isFailure: undefined as undefined | ((error: unknown) => boolean) },
}));

vi.mock("./circuit-breaker", async () => {
  const actual = await vi.importActual<typeof import("./circuit-breaker")>("./circuit-breaker");
  return {
    ...actual,
    withCircuitBreaker: async <T,>(
      options: { service: string; isFailure?: (error: unknown) => boolean },
      call: () => Promise<T>,
    ): Promise<T> => {
      breaker.captured.isFailure = options.isFailure;
      if (breaker.open.value) throw new actual.CircuitOpenError(options.service);
      return call();
    },
  };
});

import {
  META_GRAPH_VERSION,
  META_INSIGHTS_SCOPE,
  META_PUBLISH_SCOPE,
  META_TIMEOUT_MS,
  META_V1_SCOPES,
  MetaError,
  buildAuthorizeUrl,
  debugToken,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getMetaCredentials,
  isMetaConfigured,
  listPages,
  readPageInsights,
  revokePermissions,
} from "./meta";

const APP_ID = "1234567890";
const APP_SECRET = "test-app-secret-value";
const USER_TOKEN = "EAAGshort-lived-user-token";
const PAGE_TOKEN = "EAAGpage-scoped-token";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let requests: CapturedRequest[] = [];

function mockFetchOnce(status: number, body: unknown, options?: { raw?: string }): void {
  vi.mocked(globalThis.fetch).mockImplementationOnce(async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const text = options?.raw ?? JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  });
}

function goDormant(): void {
  delete serverEnv.META_APP_ID;
  delete serverEnv.META_APP_SECRET;
}

beforeEach(() => {
  requests = [];
  breaker.open.value = false;
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  serverEnv.META_APP_ID = APP_ID;
  serverEnv.META_APP_SECRET = APP_SECRET;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dormant until credentialed", () => {
  it("reports not configured when neither variable is set", () => {
    goDormant();
    expect(isMetaConfigured()).toBe(false);
    expect(getMetaCredentials()).toBeNull();
  });

  it("treats half a configuration as not configured, and warns", () => {
    // An app id without its secret cannot produce a WRONG connection, only no
    // connection, so the honest behaviour is the dormant one - with a warning,
    // because it is still someone's half-finished deployment.
    delete serverEnv.META_APP_SECRET;
    expect(isMetaConfigured()).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it("never throws from the configuration probe, so a render path is safe", () => {
    goDormant();
    expect(() => isMetaConfigured()).not.toThrow();
  });

  it("returns no authorize URL when dormant", () => {
    goDormant();
    expect(buildAuthorizeUrl({ redirectUri: "https://giya.ph/cb", state: "s" })).toBeNull();
  });

  it("throws a typed META_NOT_CONFIGURED from every operation when dormant", async () => {
    goDormant();

    const expected = expect.objectContaining({ code: "META_NOT_CONFIGURED", retryable: false });

    await expect(
      exchangeCodeForToken({ code: "c", redirectUri: "https://giya.ph/cb" }),
    ).rejects.toEqual(expected);
    await expect(exchangeForLongLivedToken({ accessToken: USER_TOKEN })).rejects.toEqual(expected);
    await expect(listPages({ userAccessToken: USER_TOKEN })).rejects.toEqual(expected);
    await expect(
      readPageInsights({ pageId: "p", pageAccessToken: PAGE_TOKEN, metrics: ["page_impressions"] }),
    ).rejects.toEqual(expected);
    await expect(debugToken({ accessToken: USER_TOKEN })).rejects.toEqual(expected);
    // No network call was attempted for any of them.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("still disconnects locally when dormant (revoke is best effort)", async () => {
    goDormant();
    await expect(revokePermissions({ accessToken: USER_TOKEN })).resolves.toBe(false);
  });
});

describe("buildAuthorizeUrl", () => {
  it("requests the four read scopes AND pages_manage_posts", () => {
    const url = new URL(
      buildAuthorizeUrl({ redirectUri: "https://giya.ph/cb", state: "nonce-1" }) ?? "",
    );

    expect(url.origin + url.pathname).toBe(
      `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`,
    );
    // Transcribed as a literal, deliberately. If this string is ever rebuilt
    // from META_V1_SCOPES it can no longer disagree with the code, and the
    // whole value of the assertion is that it can.
    expect(url.searchParams.get("scope")).toBe(
      "pages_show_list,pages_read_engagement,read_insights,instagram_basic,pages_manage_posts",
    );
    expect(url.searchParams.get("state")).toBe("nonce-1");
    expect(url.searchParams.get("client_id")).toBe(APP_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("still does NOT request instagram_content_publish", () => {
    // The OTHER [SCALE] scope stays deferred. Nothing in this codebase posts
    // to Instagram from a merchant surface, and `publishInstagramMedia` is
    // reachable from no route, so asking for it would be exactly the
    // unjustifiable review line item that the pages_manage_posts decision is
    // careful to be able to justify.
    const url = new URL(buildAuthorizeUrl({ redirectUri: "https://giya.ph/cb", state: "s" }) ?? "");
    expect(url.searchParams.get("scope")).not.toContain("instagram_content_publish");
  });

  it("never puts the app secret in the dialog URL", () => {
    const url = buildAuthorizeUrl({ redirectUri: "https://giya.ph/cb", state: "s" }) ?? "";
    expect(url).not.toContain(APP_SECRET);
  });

  it("exposes the V1 scope list as the four read scopes plus the publish scope", () => {
    expect([...META_V1_SCOPES]).toEqual([
      "pages_show_list",
      "pages_read_engagement",
      "read_insights",
      "instagram_basic",
      "pages_manage_posts",
    ]);
  });

  it("names the publish and insights scopes as literals the gates can be checked against", () => {
    // Both are exported so no gate has to spell a Meta permission inline, and
    // both are asserted against a hand-typed literal so the exported value
    // cannot silently become something Meta has never heard of.
    expect(META_PUBLISH_SCOPE).toBe("pages_manage_posts");
    expect(META_INSIGHTS_SCOPE).toBe("read_insights");
    // The publish scope must be one the OAuth grant actually asks for, or the
    // gate below it would be checking for a permission nobody ever requested.
    expect([...META_V1_SCOPES]).toContain("pages_manage_posts");
  });
});

describe("token exchange", () => {
  it("exchanges a code and computes the expiry", async () => {
    mockFetchOnce(200, { access_token: USER_TOKEN, token_type: "bearer", expires_in: 3600 });

    const result = await exchangeCodeForToken({
      code: "the-code",
      redirectUri: "https://giya.ph/cb",
    });

    expect(result.accessToken).toBe(USER_TOKEN);
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect((result.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it("sends the app secret in the POST body, never in the URL", async () => {
    // Meta's own docs show this as a GET with the secret in the query string,
    // which would put the application's master credential in every proxy log
    // between here and Menlo Park.
    mockFetchOnce(200, { access_token: USER_TOKEN, expires_in: 3600 });
    await exchangeCodeForToken({ code: "the-code", redirectUri: "https://giya.ph/cb" });

    const request = requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).not.toContain(APP_SECRET);
    expect(request?.url).not.toContain("the-code");
    expect(request?.body).toContain(encodeURIComponent(APP_SECRET));
  });

  it("exchanges a short-lived token for a long-lived one", async () => {
    mockFetchOnce(200, { access_token: "EAAGlong-lived", expires_in: 5_184_000 });

    const result = await exchangeForLongLivedToken({ accessToken: USER_TOKEN });
    expect(result.accessToken).toBe("EAAGlong-lived");
    expect(requests[0]?.body).toContain("grant_type=fb_exchange_token");
    expect(requests[0]?.body).toContain(encodeURIComponent(USER_TOKEN));
    // and the subject token is not in the URL either
    expect(requests[0]?.url).not.toContain(USER_TOKEN);
  });

  it("treats an absent expires_in as no stated expiry rather than as now", async () => {
    mockFetchOnce(200, { access_token: "EAAGnever" });
    await expect(exchangeForLongLivedToken({ accessToken: USER_TOKEN })).resolves.toEqual({
      accessToken: "EAAGnever",
      expiresAt: null,
    });
  });
});

describe("listPages", () => {
  it("returns each page with its own page-scoped token", async () => {
    mockFetchOnce(200, {
      data: [
        { id: "1001", name: "Kape Cebu", access_token: PAGE_TOKEN, category: "Coffee shop" },
        { id: "1002", name: "Kape Manila", access_token: "EAAGother" },
      ],
    });

    const pages = await listPages({ userAccessToken: USER_TOKEN });

    expect(pages).toHaveLength(2);
    expect(pages[0]).toEqual({
      id: "1001",
      name: "Kape Cebu",
      accessToken: PAGE_TOKEN,
      category: "Coffee shop",
    });
    expect(pages[1]?.category).toBeNull();
  });

  it("sends the token as an Authorization header, never as a query parameter", async () => {
    // A query-string token travels in proxy access logs and in the `url` field
    // of almost every HTTP error object ever designed.
    mockFetchOnce(200, { data: [] });
    await listPages({ userAccessToken: USER_TOKEN });

    expect(requests[0]?.url).not.toContain(USER_TOKEN);
    expect(requests[0]?.url).not.toContain("access_token=");
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${USER_TOKEN}`);
  });

  it("rejects a response that is not the documented shape", async () => {
    mockFetchOnce(200, { data: [{ id: "1001", name: "No token here" }] });
    await expect(listPages({ userAccessToken: USER_TOKEN })).rejects.toEqual(
      expect.objectContaining({ code: "META_BAD_RESPONSE", retryable: false }),
    );
  });

  it("does not quote the offending value in a schema failure", async () => {
    // Zod issues include the value that failed, and on a token endpoint the
    // value that failed is a token.
    mockFetchOnce(200, { data: [{ id: "1001", name: 42, access_token: PAGE_TOKEN }] });
    const error = await listPages({ userAccessToken: USER_TOKEN }).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain(PAGE_TOKEN);
  });
});

describe("readPageInsights", () => {
  it("maps metric series", async () => {
    mockFetchOnce(200, {
      data: [
        {
          name: "page_impressions",
          period: "day",
          title: "Daily impressions",
          values: [{ value: 120, end_time: "2026-07-01T07:00:00+0000" }, { value: 90 }],
        },
      ],
    });

    const metrics = await readPageInsights({
      pageId: "1001",
      pageAccessToken: PAGE_TOKEN,
      metrics: ["page_impressions"],
      period: "day",
    });

    expect(metrics[0]?.name).toBe("page_impressions");
    expect(metrics[0]?.values[0]).toEqual({ value: 120, endTime: "2026-07-01T07:00:00+0000" });
    expect(metrics[0]?.values[1]?.endTime).toBeNull();
  });

  it("refuses an empty metric list without calling Meta", async () => {
    await expect(
      readPageInsights({ pageId: "1001", pageAccessToken: PAGE_TOKEN, metrics: [] }),
    ).rejects.toEqual(expect.objectContaining({ code: "META_BAD_REQUEST" }));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("passes since/until as unix seconds", async () => {
    mockFetchOnce(200, { data: [] });
    await readPageInsights({
      pageId: "1001",
      pageAccessToken: PAGE_TOKEN,
      metrics: ["page_impressions"],
      since: new Date("2026-07-01T00:00:00Z"),
      until: new Date("2026-07-08T00:00:00Z"),
    });
    const url = new URL(requests[0]?.url ?? "");
    expect(url.searchParams.get("since")).toBe("1782864000");
    expect(url.searchParams.get("until")).toBe("1783468800");
  });
});

describe("error mapping", () => {
  it("maps an OAuthException to a terminal auth failure", async () => {
    mockFetchOnce(400, {
      error: { message: "Error validating access token", type: "OAuthException", code: 190 },
    });

    const error = await listPages({ userAccessToken: USER_TOKEN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaError);
    expect((error as MetaError).code).toBe("META_AUTH_FAILED");
    expect((error as MetaError).retryable).toBe(false);
    expect((error as MetaError).providerCode).toBe(190);
  });

  it("maps Meta's rate-limit codes even though they arrive as a 400", async () => {
    mockFetchOnce(400, { error: { message: "Application request limit reached", code: 4 } });
    await expect(listPages({ userAccessToken: USER_TOKEN })).rejects.toEqual(
      expect.objectContaining({ code: "META_RATE_LIMITED", retryable: true }),
    );
  });

  it("maps 5xx to a retryable unavailability", async () => {
    mockFetchOnce(503, { error: { message: "temporarily unavailable" } });
    await expect(listPages({ userAccessToken: USER_TOKEN })).rejects.toEqual(
      expect.objectContaining({ code: "META_UNAVAILABLE", retryable: true }),
    );
  });

  it("maps an unrecognised 400 to a terminal bad request", async () => {
    mockFetchOnce(400, { error: { message: "Unknown path components", code: 2500 } });
    await expect(listPages({ userAccessToken: USER_TOKEN })).rejects.toEqual(
      expect.objectContaining({ code: "META_BAD_REQUEST", retryable: false }),
    );
  });

  it("maps a transport failure to a retryable unavailability", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(listPages({ userAccessToken: USER_TOKEN })).rejects.toEqual(
      expect.objectContaining({ code: "META_UNAVAILABLE", retryable: true }),
    );
  });

  it("maps an abort to META_TIMEOUT", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(timeout);
    await expect(listPages({ userAccessToken: USER_TOKEN })).rejects.toEqual(
      expect.objectContaining({ code: "META_TIMEOUT", retryable: true }),
    );
  });

  it("maps a non-JSON 200 to a bad response", async () => {
    mockFetchOnce(200, undefined, { raw: "<html>maintenance</html>" });
    await expect(listPages({ userAccessToken: USER_TOKEN })).rejects.toEqual(
      expect.objectContaining({ code: "META_BAD_RESPONSE" }),
    );
  });

  it("never echoes Meta's own message, which can quote the request", async () => {
    mockFetchOnce(400, {
      error: { message: `Invalid token: ${USER_TOKEN}`, type: "OAuthException", code: 190 },
    });
    const error = await listPages({ userAccessToken: USER_TOKEN }).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(USER_TOKEN);
    expect((error as Error).message).toBe("Meta rejected the stored credential.");
  });
});

describe("circuit breaker wiring", () => {
  it("sets a 10s timeout on the request", async () => {
    expect(META_TIMEOUT_MS).toBe(10_000);
    mockFetchOnce(200, { data: [] });
    await listPages({ userAccessToken: USER_TOKEN });
    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("translates an open circuit into META_CIRCUIT_OPEN", async () => {
    breaker.open.value = true;
    await expect(listPages({ userAccessToken: USER_TOKEN })).rejects.toEqual(
      expect.objectContaining({ code: "META_CIRCUIT_OPEN", retryable: true }),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("counts only dependency failures against the circuit", async () => {
    // A dead token belongs to one connection. If it opened the breaker, one
    // merchant who deleted their Page would stop insights for every tenant.
    mockFetchOnce(200, { data: [] });
    await listPages({ userAccessToken: USER_TOKEN });

    const isFailure = breaker.captured.isFailure;
    expect(isFailure).toBeDefined();

    const counts = (code: string): boolean =>
      isFailure?.(new MetaError(code as never, "x", { retryable: true })) ?? false;

    expect(counts("META_UNAVAILABLE")).toBe(true);
    expect(counts("META_TIMEOUT")).toBe(true);
    expect(counts("META_RATE_LIMITED")).toBe(true);
    expect(counts("META_AUTH_FAILED")).toBe(false);
    expect(counts("META_BAD_REQUEST")).toBe(false);
    expect(counts("META_BAD_RESPONSE")).toBe(false);
  });
});

describe("debugToken", () => {
  it("reports the scopes actually granted", async () => {
    // A user can uncheck a permission in the consent dialog. Recording what we
    // ASKED for would turn "you did not grant this" into an unexplained blank.
    mockFetchOnce(200, {
      data: {
        app_id: APP_ID,
        is_valid: true,
        scopes: ["pages_show_list", "read_insights"],
        expires_at: 1_790_000_000,
      },
    });

    const result = await debugToken({ accessToken: USER_TOKEN });
    expect(result.isValid).toBe(true);
    expect(result.scopes).toEqual(["pages_show_list", "read_insights"]);
    expect(result.expiresAt).toEqual(new Date(1_790_000_000 * 1000));
  });

  it("treats Meta's expires_at of 0 as never expiring", async () => {
    mockFetchOnce(200, { data: { is_valid: true, expires_at: 0 } });
    await expect(debugToken({ accessToken: USER_TOKEN })).resolves.toEqual({
      isValid: true,
      scopes: [],
      expiresAt: null,
    });
  });
});

describe("revokePermissions", () => {
  it("returns true when Meta accepts the revoke", async () => {
    mockFetchOnce(200, { success: true });
    await expect(revokePermissions({ accessToken: USER_TOKEN })).resolves.toBe(true);
  });

  it("never throws when Meta refuses, so disconnect is not blocked", async () => {
    // doc 42: "best-effort revokes the grant". A merchant clicking Disconnect
    // must end up disconnected whatever Meta says.
    mockFetchOnce(500, { error: { message: "nope" } });
    await expect(revokePermissions({ accessToken: USER_TOKEN })).resolves.toBe(false);
  });

  it("does not log the token when the revoke fails", async () => {
    mockFetchOnce(500, { error: { message: "nope" } });
    await revokePermissions({ accessToken: USER_TOKEN });
    const logged = vi.mocked(console.warn).mock.calls.flat().join(" ");
    expect(logged).not.toContain(USER_TOKEN);
  });
});
