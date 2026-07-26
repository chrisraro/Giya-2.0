// @vitest-environment node
//
// The gateway's contract has two halves and both are load-bearing:
//
//   * it never throws, so a provider outage cannot break the worker; and
//   * every failure says whether ANOTHER ATTEMPT COULD HELP, because doc 39's
//     failure taxonomy turns on exactly that. Collapsing the two would either
//     retry a malformed address five times or give up on a blip.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const envValue: { RESEND_API_KEY?: string; EMAIL_FROM?: string } = {
  RESEND_API_KEY: "re_test_key",
};

vi.mock("@/lib/env", () => ({
  env: {},
  getServerEnv: () => envValue,
}));

import { DEFAULT_FROM, resolveFrom, sendEmail } from "./send";

const MESSAGE = {
  to: "someone@example.com",
  subject: "We could not read this photo",
  html: "<p>hi</p>",
  text: "hi",
};

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  envValue.RESEND_API_KEY = "re_test_key";
  delete envValue.EMAIL_FROM;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveFrom", () => {
  // The placeholder is the default because it is the only address that can send
  // at all today: no domain is verified and the key is send-scoped, so this
  // code could not check the domain list even if it wanted to.
  it("falls back to Resend's sandbox sender", () => {
    expect(resolveFrom(undefined)).toBe(DEFAULT_FROM);
    expect(DEFAULT_FROM).toContain("onboarding@resend.dev");
  });

  it("prefers EMAIL_FROM once a verified sender exists", () => {
    envValue.EMAIL_FROM = "Giya <no-reply@giya.ph>";
    expect(resolveFrom(undefined)).toBe("Giya <no-reply@giya.ph>");
  });

  it("prefers an explicit override over both", () => {
    envValue.EMAIL_FROM = "Giya <no-reply@giya.ph>";
    expect(resolveFrom("Other <a@b.co>")).toBe("Other <a@b.co>");
  });
});

describe("sendEmail", () => {
  it("posts both parts and returns the provider's id", async () => {
    const doFetch = respond(200, { id: "resend-1" });
    const result = await sendEmail({ ...MESSAGE, fetchImpl: doFetch });

    expect(result).toEqual({ ok: true, id: "resend-1" });

    const [url, init] = vi.mocked(doFetch).mock.calls[0] ?? [];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      from: DEFAULT_FROM,
      to: ["someone@example.com"],
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      // The plain-text part is REQUIRED on every send, never omitted.
      text: MESSAGE.text,
    });
  });

  // Doc 39's retryable class: "Resend transient". A 429 clears in seconds and
  // giving up on it would drop a real message.
  it("classifies a rate limit as retryable", async () => {
    const result = await sendEmail({ ...MESSAGE, fetchImpl: respond(429, { message: "slow down" }) });
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it("classifies a provider fault as retryable", async () => {
    const result = await sendEmail({ ...MESSAGE, fetchImpl: respond(503, { message: "down" }) });
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it("classifies an unreachable provider as retryable", async () => {
    const result = await sendEmail({
      ...MESSAGE,
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  // Doc 39's terminal class. Re-sending an identical bad request cannot change
  // the answer; it only burns four more attempts before the DLQ says the same
  // thing.
  it("classifies a malformed request as terminal", async () => {
    const result = await sendEmail({
      ...MESSAGE,
      fetchImpl: respond(422, { message: "Invalid `to` field" }),
    });
    expect(result).toMatchObject({ ok: false, retryable: false });
    if (!result.ok) expect(result.reason).toContain("422");
  });

  it("classifies a revoked key as terminal", async () => {
    const result = await sendEmail({ ...MESSAGE, fetchImpl: respond(401, { message: "nope" }) });
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  // The one outcome worse than not knowing whether an email went out is sending
  // it again to find out.
  it("treats an accepted send with an unreadable body as terminal", async () => {
    const result = await sendEmail({
      ...MESSAGE,
      fetchImpl: vi.fn(async () => new Response("<html>ok</html>", { status: 200 })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it("treats an accepted send with no id as terminal", async () => {
    const result = await sendEmail({ ...MESSAGE, fetchImpl: respond(200, { queued: true }) });
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  // A credential does not appear by retrying. Marking this retryable would have
  // every queued email spend five attempts and land in the DLQ, burying the
  // real failures under a pile of "not configured".
  it("is terminal, and never calls out, with no API key", async () => {
    delete envValue.RESEND_API_KEY;
    const doFetch = respond(200, { id: "should-not-happen" });
    const result = await sendEmail({ ...MESSAGE, fetchImpl: doFetch });
    expect(result).toEqual({
      ok: false,
      retryable: false,
      reason: "email is not configured",
    });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("never throws, whatever the provider does", async () => {
    await expect(
      sendEmail({
        ...MESSAGE,
        fetchImpl: (() => {
          throw new Error("synchronous explosion");
        }) as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});
