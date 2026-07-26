// @vitest-environment node
//
// The deauthorize webhook, and the two things only an end-to-end test of the
// route can prove:
//
//   1. NOTHING HAPPENS BEFORE THE SIGNATURE IS CHECKED. An unsigned request
//      must not be parsed, must not reach the dedupe store, must not reach the
//      database, and must be told nothing about why it was refused.
//   2. THE STATUS CODE IS A RETRY DECISION. Meta retries non-2xx, so every
//      branch another delivery cannot improve answers 200 - including
//      "unparseable body" and "no matching connection". 401 is the single
//      exception, and it is not a retry decision: an unsigned request is not
//      an event.

import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const SECRET = "test-meta-app-secret";
const VERIFY_TOKEN = "test-verify-token";

vi.mock("@/lib/env", () => ({
  env: {},
  getServerEnv: () => ({
    META_APP_SECRET: "test-meta-app-secret",
    META_WEBHOOK_VERIFY_TOKEN: "test-verify-token",
  }),
}));

const redis = vi.hoisted(() => ({ setNx: vi.fn() }));
vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
  setNx: (...args: unknown[]) => redis.setNx(...args),
}));

const markDeauthorized = vi.hoisted(() => vi.fn());
vi.mock("@/features/integrations/meta/server/service", () => ({
  markDeauthorized: (...args: unknown[]) => markDeauthorized(...args),
}));

import { NextRequest } from "next/server";

import { GET, POST } from "./route";

const BODY = JSON.stringify({
  object: "permissions",
  entry: [{ id: "1001", time: 1_790_000_000, changed_fields: ["pages_show_list"] }],
});

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function post(body: string, signature: string | null): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) headers.set("x-hub-signature-256", signature);
  return new NextRequest("https://giya.ph/api/webhooks/meta", {
    method: "POST",
    headers,
    body,
  });
}

beforeEach(() => {
  redis.setNx.mockReset().mockResolvedValue(true);
  markDeauthorized.mockReset().mockResolvedValue(1);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST, unsigned", () => {
  it("answers 401 and does nothing else", async () => {
    const response = await POST(post(BODY, null));

    expect(response.status).toBe(401);
    // Nothing was claimed, nothing was applied. The order in the route is the
    // security model, and this is what asserts it.
    expect(redis.setNx).not.toHaveBeenCalled();
    expect(markDeauthorized).not.toHaveBeenCalled();
  });

  it("answers 401 with an empty body, naming no reason", async () => {
    // A named rejection tells whoever is probing whether the endpoint is wired
    // up, and tells them when a forgery is failing for a reason other than the
    // signature.
    const response = await POST(post(BODY, "sha256=" + "0".repeat(64)));

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  it("refuses a signature over a DIFFERENT body", async () => {
    // The replay an attacker would attempt with a captured signature.
    const captured = sign(BODY);
    const forged = JSON.stringify({ object: "permissions", entry: [{ id: "9999" }] });

    const response = await POST(post(forged, captured));

    expect(response.status).toBe(401);
    expect(markDeauthorized).not.toHaveBeenCalled();
  });

  it("refuses a signature made with a different secret", async () => {
    const response = await POST(post(BODY, sign(BODY, "not-the-secret")));
    expect(response.status).toBe(401);
  });
});

describe("POST, signed", () => {
  it("marks the named accounts revoked and answers 200", async () => {
    const response = await POST(post(BODY, sign(BODY)));

    expect(response.status).toBe(200);
    expect(markDeauthorized).toHaveBeenCalledWith(["1001"]);
  });

  it("verifies the RAW bytes, so whitespace does not break a genuine delivery", async () => {
    // The mistake the whole verification module is written around: a
    // parse-then-reserialize would hash a different string.
    const spaced = `{\n  "object": "page",\n  "entry": [ { "id": "2002" } ]\n}`;
    const response = await POST(post(spaced, sign(spaced)));

    expect(response.status).toBe(200);
    expect(markDeauthorized).toHaveBeenCalledWith(["2002"]);
  });

  it("is idempotent: a redelivery is a 200 that does no work", async () => {
    redis.setNx.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const first = await POST(post(BODY, sign(BODY)));
    const second = await POST(post(BODY, sign(BODY)));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(markDeauthorized).toHaveBeenCalledTimes(1);
  });

  it("claims the delivery with a 24h SET NX, per doc 42", async () => {
    await POST(post(BODY, sign(BODY)));
    expect(redis.setNx).toHaveBeenCalledWith(expect.stringContaining("wh:meta:"), "1", 86_400);
  });

  it("does not process when the dedupe store is unreachable, and still answers 200", async () => {
    // Fails closed on the work, open on the status: asking Meta to redeliver
    // would not help while the dedupe store is down.
    redis.setNx.mockRejectedValue(new Error("redis down"));

    const response = await POST(post(BODY, sign(BODY)));

    expect(response.status).toBe(200);
    expect(markDeauthorized).not.toHaveBeenCalled();
  });

  it("answers 200 for a signed body that is not JSON", async () => {
    const body = "not json at all";
    const response = await POST(post(body, sign(body)));

    expect(response.status).toBe(200);
    expect(markDeauthorized).not.toHaveBeenCalled();
  });

  it("answers 200 when the payload names no account", async () => {
    const body = JSON.stringify({ object: "permissions", entry: [] });
    const response = await POST(post(body, sign(body)));

    expect(response.status).toBe(200);
    expect(markDeauthorized).not.toHaveBeenCalled();
  });

  it("answers 200 even when applying the revoke throws", async () => {
    // The delivery is already claimed, so a retry would be deduped anyway, and
    // refresh-on-read will catch the dead token.
    markDeauthorized.mockRejectedValue(new Error("database down"));

    const response = await POST(post(BODY, sign(BODY)));
    expect(response.status).toBe(200);
  });

  it("never echoes the payload back to the caller", async () => {
    const response = await POST(post(BODY, sign(BODY)));
    expect(await response.text()).toBe(JSON.stringify({ received: true }));
  });
});

describe("GET handshake", () => {
  function get(params: Record<string, string>): NextRequest {
    const url = new URL("https://giya.ph/api/webhooks/meta");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return new NextRequest(url, { method: "GET" });
  }

  it("echoes the challenge as plain text when the token matches", async () => {
    const response = GET(
      get({
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": "1158201444",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("1158201444");
  });

  it("refuses a wrong verify token with 403 and echoes nothing", async () => {
    const response = GET(
      get({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "115" }),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
  });

  it("refuses to echo a challenge presented without the handshake mode", async () => {
    // An endpoint that echoes anything is a way for someone else to register
    // our URL against their app.
    const response = GET(get({ "hub.challenge": "115", "hub.verify_token": VERIFY_TOKEN }));
    expect(response.status).toBe(403);
  });
});
