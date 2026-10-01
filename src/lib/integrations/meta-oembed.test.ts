import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const serverEnv: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({
  getServerEnv: () => serverEnv,
}));

import { META_GRAPH_VERSION } from "./meta-version";
import { getFacebookPageEmbed } from "./meta-oembed";

const fetchMock = vi.fn();

beforeEach(() => {
  for (const key of Object.keys(serverEnv)) delete serverEnv[key];
  serverEnv.META_APP_ID = "123";
  serverEnv.META_CLIENT_TOKEN = "client-token";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// Meta's real answer before App Review approves oEmbed Read (captured
// 2026-10-01 against app 849285887880230 with a valid client token).
const NOT_APPROVED = {
  error: {
    message:
      "(#10) To use 'oEmbed Read', your use of this endpoint must be reviewed and approved by Facebook.",
    type: "OAuthException",
    code: 10,
  },
};

describe("getFacebookPageEmbed", () => {
  it("returns the embed html from oembed_page", async () => {
    fetchMock.mockResolvedValue(json({ html: '<div class="fb-page"></div>' }));

    await expect(getFacebookPageEmbed("https://www.facebook.com/Meta")).resolves.toEqual({
      status: "ok",
      html: '<div class="fb-page"></div>',
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit & { next?: { revalidate?: number } }];
    expect(url.origin + url.pathname).toBe(`https://graph.facebook.com/${META_GRAPH_VERSION}/oembed_page`);
    expect(url.searchParams.get("url")).toBe("https://www.facebook.com/Meta");
    expect(url.searchParams.get("maxwidth")).toBe("500");
    expect(url.searchParams.get("omitscript")).toBe("true");
    expect(init.next?.revalidate).toBe(86_400);
  });

  it("sends the app token in the Authorization header, never the URL", async () => {
    fetchMock.mockResolvedValue(json({ html: "<div></div>" }));

    await getFacebookPageEmbed("https://www.facebook.com/Meta");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).not.toContain("client-token");
    expect(url.searchParams.has("access_token")).toBe(false);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer 123|client-token");
  });

  it("reports pending_review when Meta says oEmbed Read is not approved yet (#10)", async () => {
    fetchMock.mockResolvedValue(json(NOT_APPROVED, 400));

    await expect(getFacebookPageEmbed("https://www.facebook.com/Meta")).resolves.toEqual({
      status: "pending_review",
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("code 10"));
  });

  it("is unavailable for any other Meta error, logging the status", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 190, message: "bad token" } }, 401));

    await expect(getFacebookPageEmbed("https://www.facebook.com/Meta")).resolves.toEqual({
      status: "unavailable",
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("401"));
  });

  it("is unavailable on a non-JSON error body", async () => {
    fetchMock.mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(getFacebookPageEmbed("https://www.facebook.com/Meta")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("does not call Meta for a URL outside the allowlist", async () => {
    await expect(getFacebookPageEmbed("https://facebook.com.evil.com/Meta")).resolves.toEqual({
      status: "unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is unavailable without calling Meta when the app is not configured, and says so", async () => {
    delete serverEnv.META_CLIENT_TOKEN;
    await expect(getFacebookPageEmbed("https://www.facebook.com/Meta")).resolves.toEqual({
      status: "unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("not configured"));
  });

  it("is unavailable on a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(getFacebookPageEmbed("https://www.facebook.com/Meta")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("is unavailable when a 200 body has no html", async () => {
    fetchMock.mockResolvedValue(json({ provider_name: "Facebook" }));
    await expect(getFacebookPageEmbed("https://www.facebook.com/Meta")).resolves.toEqual({
      status: "unavailable",
    });
  });
});
