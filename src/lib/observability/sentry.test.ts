import { describe, expect, it } from "vitest";

import { buildSentryOptions, readDsn, scrubEvent } from "./sentry";
import type { SentryEventLike } from "./sentry";

// The pure half of the Sentry wiring: what counts as a DSN, what the init
// options are, and what never leaves the process. The hooks that USE these
// live in src/instrumentation.ts and src/instrumentation-client.ts and are
// tested there.
//
// Every case below runs with an explicit env object rather than the ambient
// one, because the ambient one has no DSN and never will - which is the point
// of the module, but would make "with a DSN" untestable if it were the only
// source.

const DSN = "https://abc123@o1.ingest.sentry.io/42";

describe("readDsn", () => {
  it("reads SENTRY_DSN on the server", () => {
    expect(readDsn({ SENTRY_DSN: DSN })).toBe(DSN);
  });

  it("returns null for every way of not having one", () => {
    // All four collapse to null on purpose: they mean the same thing to every
    // caller, and collapsing them here is what lets each call site be one `if`.
    expect(readDsn({})).toBeNull();
    expect(readDsn({ SENTRY_DSN: "" })).toBeNull();
    expect(readDsn({ SENTRY_DSN: "   " })).toBeNull();
    expect(readDsn({ SENTRY_DSN: "not-a-dsn" })).toBeNull();
    expect(readDsn({ SENTRY_DSN: "https://o1.ingest.sentry.io/42" })).toBeNull();
  });

  it("reads ONLY the public variable in the browser, with no fallback", () => {
    // Next inlines only NEXT_PUBLIC_*, so a client reading SENTRY_DSN would
    // read undefined forever. A fallback would therefore be a branch that
    // cannot be taken in production and exists only to make a Node test pass.
    const publicDsn = "https://xyz789@o1.ingest.sentry.io/43";
    expect(readDsn({ SENTRY_DSN: DSN, NEXT_PUBLIC_SENTRY_DSN: publicDsn }, { client: true })).toBe(
      publicDsn,
    );
    expect(readDsn({ SENTRY_DSN: DSN }, { client: true })).toBeNull();
    expect(readDsn({ SENTRY_DSN: DSN, NEXT_PUBLIC_SENTRY_DSN: publicDsn })).toBe(DSN);
  });

  it("lets the public variable serve the server too, so one key can configure both", () => {
    const publicDsn = "https://xyz789@o1.ingest.sentry.io/43";
    expect(readDsn({ NEXT_PUBLIC_SENTRY_DSN: publicDsn })).toBe(publicDsn);
  });
});

describe("buildSentryOptions", () => {
  it("never opts in to Sentry's own idea of personal data", () => {
    expect(buildSentryOptions({ dsn: DSN, env: {} }).sendDefaultPii).toBe(false);
  });

  it("leaves tracing off unless an operator asks for it", () => {
    expect(buildSentryOptions({ dsn: DSN, env: {} }).tracesSampleRate).toBe(0);
  });

  it("honours a sample rate that is a rate, and ignores one that is not", () => {
    const rate = (value: string | undefined) =>
      buildSentryOptions({ dsn: DSN, env: { SENTRY_TRACES_SAMPLE_RATE: value } })
        .tracesSampleRate;

    expect(rate("0.25")).toBe(0.25);
    expect(rate("1")).toBe(1);
    // A typo must not become a 100% sampling bill, and must not throw either.
    expect(rate("banana")).toBe(0);
    expect(rate("50")).toBe(0);
    expect(rate("-1")).toBe(0);
  });

  it("sets the release from the platform commit sha, since no build plugin will", () => {
    // Without withSentryConfig nothing injects a release. An issue that cannot
    // say which deploy it came from is the gap this whole task is about.
    const options = buildSentryOptions({
      dsn: DSN,
      env: { VERCEL_GIT_COMMIT_SHA: "aeeaaa5deadbeef" },
    });
    expect(options.release).toBe("aeeaaa5deadbeef");
  });

  it("omits the release rather than sending an empty one off-platform", () => {
    expect(buildSentryOptions({ dsn: DSN, env: {} })).not.toHaveProperty("release");
  });

  it("scrubs through beforeSend and beforeSendTransaction alike", () => {
    const options = buildSentryOptions({ dsn: DSN, env: {} });
    const event: SentryEventLike = { request: { url: "/x", data: { password: "hunter2" } } };

    for (const key of ["beforeSend", "beforeSendTransaction"] as const) {
      const hook = options[key] as (e: SentryEventLike) => SentryEventLike;
      expect(hook(event).request).not.toHaveProperty("data");
    }
  });
});

describe("scrubEvent", () => {
  it("drops the request body, the query string and the cookies", () => {
    // THE FIXTURE CARRIES A QUERY IN THE URL, and that is the point. The
    // version of this test that shipped first used a bare path, so the words
    // "the query string" could not disagree with the code: `query_string` was
    // deleted, the identical parameters survived inside `url`, and the
    // assertion passed. @sentry/core writes the query into both fields.
    const scrubbed = scrubEvent({
      request: {
        url: "https://giya.test/api/v1/receipts?token=abc&cursor=42",
        method: "POST",
        data: { receipt_number: "R-1", total_centavos: 12_500 },
        query_string: "token=abc&cursor=42",
        cookies: { "sb-access-token": "eyJ.a.b" },
      },
    });

    expect(scrubbed.request).not.toHaveProperty("data");
    expect(scrubbed.request).not.toHaveProperty("query_string");
    expect(scrubbed.request).not.toHaveProperty("cookies");
    // What is left is what identifies the request without describing anyone.
    expect(scrubbed.request?.url).toBe("https://giya.test/api/v1/receipts");
    expect(scrubbed.request?.method).toBe("POST");
    expect(JSON.stringify(scrubbed)).not.toContain("token=abc");
  });

  it("does not send an OAuth authorization code, which this app really receives", () => {
    // /api/v1/businesses/[businessId]/integrations/meta/callback. A `code` is
    // exchangeable for a Meta page access token; it must not reach a
    // third-party issue tracker, whatever the retention policy says.
    const scrubbed = scrubEvent({
      request: {
        url: "https://giya.test/api/v1/businesses/b-1/integrations/meta/callback?code=AQD_meta_oauth_code&state=xyz",
        method: "GET",
      },
    });

    expect(scrubbed.request?.url).toBe(
      "https://giya.test/api/v1/businesses/b-1/integrations/meta/callback",
    );
    expect(JSON.stringify(scrubbed)).not.toContain("AQD_meta_oauth_code");
  });

  it("strips a fragment too, where an implicit-flow token lives", () => {
    const scrubbed = scrubEvent({
      request: { url: "https://giya.test/reset-password#access_token=eyJ.a.b" },
    });

    expect(scrubbed.request?.url).toBe("https://giya.test/reset-password");
  });

  it("survives a relative or malformed url instead of throwing inside beforeSend", () => {
    // beforeSend runs on the failure path, which is exactly where a
    // half-formed URL comes from. `new URL()` would throw here and take the
    // event with it.
    expect(scrubEvent({ request: { url: "/wallet?code=secret" } }).request?.url).toBe("/wallet");
    expect(scrubEvent({ request: { url: "not a url at all" } }).request?.url).toBe(
      "not a url at all",
    );
    expect(scrubEvent({ request: { method: "GET" } }).request).not.toHaveProperty("url");
  });

  it("keeps only the correlation header, allowlisted rather than denylisted", () => {
    const scrubbed = scrubEvent({
      request: {
        headers: {
          "x-request-id": "req-abc",
          authorization: "Bearer sb_secret_leak",
          cookie: "sb-access-token=eyJ.a.b",
          "x-forwarded-for": "203.0.113.9",
          "user-agent": "Mozilla/5.0",
        },
      },
    });

    // An allowlist because a denylist has to be updated every time a framework
    // starts sending a new header, and the update always lands after the leak.
    expect(scrubbed.request?.headers).toEqual({ "x-request-id": "req-abc" });
    expect(JSON.stringify(scrubbed)).not.toContain("sb_secret_leak");
    expect(JSON.stringify(scrubbed)).not.toContain("203.0.113.9");
  });

  it("keeps the user id and drops everything else about the user", () => {
    const scrubbed = scrubEvent({
      user: {
        id: "11111111-2222-3333-4444-555555555555",
        email: "consumer@example.com",
        username: "consumer",
        ip_address: "203.0.113.9",
      },
    });

    expect(scrubbed.user).toEqual({ id: "11111111-2222-3333-4444-555555555555" });
    expect(JSON.stringify(scrubbed)).not.toContain("consumer@example.com");
  });

  it("applies src/lib/log.ts's own redaction to extra, contexts and tags", () => {
    // The same rules, from the same module, so the two scrubbers cannot drift
    // apart the next time someone adds a key to the list.
    const scrubbed = scrubEvent({
      extra: { INTEGRATION_TOKEN_AES_KEY: "abcdefghijklmnopqrstuvwxyz012345" },
      contexts: { meta: { page_access_token: "EAAG-secret" } },
      tags: { supabase_service_role_key: "sb_secret_do_not_leak" },
    });

    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(serialized).not.toContain("EAAG-secret");
    expect(serialized).not.toContain("sb_secret_do_not_leak");
    expect(scrubbed.extra).toEqual({ INTEGRATION_TOKEN_AES_KEY: "[redacted]" });
  });

  it("leaves an event that carries nothing sensitive alone", () => {
    const scrubbed = scrubEvent({
      exception: { values: [{ type: "TypeError", value: "x is not a function" }] },
      extra: { route: "receipts.scan", attempt: 2 },
    });

    expect(scrubbed.exception).toEqual({
      values: [{ type: "TypeError", value: "x is not a function" }],
    });
    expect(scrubbed.extra).toEqual({ route: "receipts.scan", attempt: 2 });
  });

  it("does not mutate the event it was given", () => {
    const event: SentryEventLike = { user: { id: "u1", email: "consumer@example.com" } };
    scrubEvent(event);
    expect(event.user?.email).toBe("consumer@example.com");
  });
});
