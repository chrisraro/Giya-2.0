import { describe, expect, it } from "vitest";

import { toFacebookPageUrl } from "./facebook-url";

describe("toFacebookPageUrl", () => {
  it.each([
    "https://facebook.com/Meta",
    "https://www.facebook.com/Meta",
    "https://web.facebook.com/Meta",
    "https://m.facebook.com/Meta",
    "https://fb.com/Meta",
    "https://www.fb.com/Meta",
    "https://WWW.FACEBOOK.COM/Meta",
  ])("accepts %s", (url) => {
    expect(toFacebookPageUrl(url)).not.toBeNull();
  });

  it("returns the normalized href", () => {
    expect(toFacebookPageUrl("  https://www.facebook.com/Meta  ")).toBe("https://www.facebook.com/Meta");
  });

  it.each([
    ["plain http", "http://www.facebook.com/Meta"],
    ["suffix lookalike", "https://facebook.com.evil.com/Meta"],
    ["prefix lookalike", "https://evilfacebook.com/Meta"],
    ["unlisted subdomain", "https://evil.facebook.com/Meta"],
    ["userinfo trick", "https://www.facebook.com@evil.com/Meta"],
    ["non-default port", "https://www.facebook.com:8443/Meta"],
    ["other scheme", "javascript:alert(1)"],
    ["not a url", "facebook.com/Meta"],
    ["empty", ""],
  ])("rejects %s", (_label, url) => {
    expect(toFacebookPageUrl(url)).toBeNull();
  });

  it.each([null, undefined, 42, {}])("rejects non-string %s", (value) => {
    expect(toFacebookPageUrl(value)).toBeNull();
  });
});
