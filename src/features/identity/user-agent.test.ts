import { describe, expect, it } from "vitest";

import { describeUserAgent } from "./user-agent";

// The device list has to be recognisable by a person. A raw user-agent string
// is not: it is 120 characters of version numbers and a lie about Mozilla, and
// printing one at a consumer who is deciding whether to remove a device tells
// them nothing they can act on.
//
// The fixtures below are real user-agent strings. Every assertion checks BOTH
// that the summary says the right thing AND that no fragment of the raw string
// survives into it - "Mozilla/5.0" appears in all of them and must appear in
// none of the outputs.

const UA = {
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  firefoxMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  samsungAndroid:
    "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  chromeIpad:
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
} as const;

describe("describeUserAgent", () => {
  it("names the browser and the platform", () => {
    expect(describeUserAgent(UA.chromeWindows)).toBe("Chrome on Windows");
  });

  it("reads an iPhone as an iPhone, not as a Mac", () => {
    // Every iOS user agent says "like Mac OS X". A naive Mac check reports
    // every iPhone in the list as a Mac, and then two rows look identical.
    expect(describeUserAgent(UA.safariIphone)).toBe("Safari on iPhone");
  });

  it("reads Android through the Linux token it also carries", () => {
    expect(describeUserAgent(UA.chromeAndroid)).toBe("Chrome on Android");
  });

  it("names Firefox on a Mac", () => {
    expect(describeUserAgent(UA.firefoxMac)).toBe("Firefox on macOS");
  });

  it("CRITICAL: reads Edge as Edge even though it also claims Chrome", () => {
    // Edge's UA contains "Chrome/126" AND "Edg/126". Checking Chrome first
    // labels every Edge device Chrome, which is exactly the kind of wrong that
    // makes somebody fail to recognise their own device.
    expect(describeUserAgent(UA.edgeWindows)).toBe("Edge on Windows");
  });

  it("CRITICAL: reads Samsung Internet as itself, not as Chrome", () => {
    // Same trap: SamsungBrowser's UA also carries "Chrome/115".
    expect(describeUserAgent(UA.samsungAndroid)).toBe("Samsung Internet on Android");
  });

  it("reads Chrome on iOS (CriOS) as Chrome, and an iPad as an iPad", () => {
    expect(describeUserAgent(UA.chromeIpad)).toBe("Chrome on iPad");
  });

  it("reads desktop Safari as Safari", () => {
    expect(describeUserAgent(UA.safariMac)).toBe("Safari on macOS");
  });

  it("CRITICAL: never leaks any part of the raw string", () => {
    for (const raw of Object.values(UA)) {
      const summary = describeUserAgent(raw);
      expect(summary).not.toMatch(/Mozilla/);
      expect(summary).not.toMatch(/AppleWebKit/);
      expect(summary).not.toMatch(/\d/);
      expect(summary.length).toBeLessThan(40);
    }
  });

  it("says something honest for a string it does not recognise", () => {
    const summary = describeUserAgent("curl/8.4.0");
    expect(summary).toBe("Unknown device");
    expect(summary).not.toContain("curl");
  });

  it("names the platform even when the browser is unrecognisable", () => {
    expect(describeUserAgent("SomeBot/1.0 (Windows NT 10.0)")).toBe("A browser on Windows");
  });

  it("names the browser even when the platform is unrecognisable", () => {
    expect(describeUserAgent("Firefox/127.0")).toBe("Firefox");
  });

  it("handles a missing user agent without inventing one", () => {
    expect(describeUserAgent(null)).toBe("Unknown device");
    expect(describeUserAgent("")).toBe("Unknown device");
  });
});
