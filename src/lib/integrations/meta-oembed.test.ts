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

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("getFacebookPageEmbed", () => {
  it("returns the embed html from oembed_page", async () => {
    fetchMock.mockResolvedValue(ok({ html: '<div class="fb-page"></div>' }));

    await expect(getFacebookPageEmbed("https://www.facebook.com/Meta")).resolves.toBe(
      '<div class="fb-page"></div>',
    );

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit & { next?: { revalidate?: number } }];
    expect(url.origin + url.pathname).toBe(`https://graph.facebook.com/${META_GRAPH_VERSION}/oembed_page`);
    expect(url.searchParams.get("url")).toBe("https://www.facebook.com/Meta");
    expect(url.searchParams.get("maxwidth")).toBe("500");
    expect(url.searchParams.get("omitscript")).toBe("true");
    expect(init.next?.revalidate).toBe(86_400);
  });

  it("sends the app token in the Authorization header, never the URL", async () => {
    fetchMock.mockResolvedValue(ok({ html: "<div></div>" }));

    await getFacebookPageEmbed("https://www.facebook.com/Meta");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).not.toContain("client-token");
    expect(url.searchParams.has("access_token")).toBe(false);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer 123|client-token");
  });

  it("does not call Meta for a URL outside the allowlist", async () => {
    await expect(getFacebookPageEmbed("https://facebook.com.evil.com/Meta")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null without calling Meta when the app is not configured", async () => {
    delete serverEnv.META_CLIENT_TOKEN;
    await expect(getFacebookPageEmbed("https://www.facebook.com/Meta")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null and logs the status on a non-2xx answer", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 400 }));

    await expect(getFacebookPageEmbed("https://www.facebook.com/Meta")).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("400"));
  });

  it("returns null on a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(getFacebookPageEmbed("https://www.facebook.com/Meta")).resolves.toBeNull();
  });

  it("returns null when the body has no html", async () => {
    fetchMock.mockResolvedValue(ok({ error: { message: "nope" } }));
    await expect(getFacebookPageEmbed("https://www.facebook.com/Meta")).resolves.toBeNull();
  });
});
