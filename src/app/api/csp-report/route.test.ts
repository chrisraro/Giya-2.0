import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkRateLimit, warn } = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit }));
vi.mock("@/lib/log", async (orig) => {
  const actual = await orig<typeof import("@/lib/log")>();
  return { ...actual, requestLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), with: vi.fn() }) };
});

import { MAX_REPORT_BYTES, POST } from "./route";

function post(body: string, contentType = "application/csp-report", headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("https://giya.test/api/csp-report", {
      method: "POST",
      body,
      headers: { "content-type": contentType, "x-forwarded-for": "203.0.113.9", ...headers },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimit.mockResolvedValue({ ok: true, remaining: 10, resetSeconds: 60 });
});

describe("POST /api/csp-report", () => {
  it("logs one stripped line for a legacy report and answers 204", async () => {
    const res = await post(
      JSON.stringify({
        "csp-report": {
          "document-uri": "https://giya.test/rewards?token=SECRET#frag",
          "effective-directive": "script-src-elem",
          "violated-directive": "script-src",
          "blocked-uri": "https://evil.example/x.js?key=SECRET",
          disposition: "report",
          "script-sample": "alert(SECRET)",
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, fields] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain("[csp]");
    expect(fields).toEqual({
      directive: "script-src-elem",
      blocked_origin: "https://evil.example",
      document_path: "/rewards",
      disposition: "report",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET");
  });

  it("handles a Reporting API array, one line per csp-violation", async () => {
    const res = await post(
      JSON.stringify([
        {
          type: "csp-violation",
          body: {
            effectiveDirective: "img-src",
            blockedURL: "https://cdn.example/a.png?sig=SECRET",
            documentURL: "https://giya.test/home?x=1",
            disposition: "enforce",
          },
        },
        { type: "deprecation", body: { id: "x" } },
        {
          type: "csp-violation",
          body: { effectiveDirective: "style-src", blockedURL: "inline", documentURL: "https://giya.test/" },
        },
      ]),
      "application/reports+json",
    );
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      blocked_origin: "https://cdn.example",
      document_path: "/home",
      disposition: "enforce",
    });
    expect(warn.mock.calls[1]?.[1]).toMatchObject({ blocked_origin: "inline", document_path: "/" });
  });

  it("reduces data: URIs to the scheme", async () => {
    await post(
      JSON.stringify({ "csp-report": { "effective-directive": "img-src", "blocked-uri": "data:image/png;base64,AAAA" } }),
    );
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ blocked_origin: "data:" });
  });

  it("answers 204 and logs nothing for malformed JSON, junk shapes or empty bodies", async () => {
    for (const body of ["{not json", "[]", "42", "null", "", JSON.stringify({ hello: "world" })]) {
      expect((await post(body)).status).toBe(204);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops an oversized body (actual and declared) with 204", async () => {
    const big = "x".repeat(MAX_REPORT_BYTES + 1);
    expect((await post(JSON.stringify({ "csp-report": { "blocked-uri": big } }))).status).toBe(204);
    expect(
      (await post("{}", "application/csp-report", { "content-length": String(MAX_REPORT_BYTES + 1) })).status,
    ).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops reports over the per-IP limit with 204", async () => {
    checkRateLimit.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 30 });
    expect((await post(JSON.stringify({ "csp-report": { "effective-directive": "img-src" } }))).status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: "csp-report:203.0.113.9", failMode: "open" }),
    );
  });

  it("still logs when the rate limiter throws (telemetry fails open)", async () => {
    checkRateLimit.mockRejectedValue(new Error("redis down"));
    expect((await post(JSON.stringify({ "csp-report": { "effective-directive": "img-src" } }))).status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
