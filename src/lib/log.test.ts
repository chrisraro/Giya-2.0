import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REQUEST_ID_PATTERN,
  jobLogger,
  redact,
  requestLogger,
  resolveRequestId,
  serializeError,
} from "./log";

// =============================================================================
// src/lib/log.ts - the structured log line.
// =============================================================================
//
// t7-5-brief.md states the bar this module exists to clear: "when the next page
// 500s, can someone say which line threw, in which request, for which user, on
// which deploy?" Every assertion below is a piece of that sentence.
//
// Two habits in here are deliberate and worth stating once:
//
//   * The line is asserted as a LITERAL STRING wherever key order is part of
//     the claim, and as a parsed object elsewhere. Neither ever reads the
//     constant the logger emits (brief constraint 2) - a test that asserts
//     `parsed.level === LEVELS.error` cannot disagree with the code.
//   * The clock is injected everywhere, so `time` is a literal too.

const CLOCK = () => new Date("2026-01-02T03:04:05.000Z");
const STAMP = "2026-01-02T03:04:05.000Z";

/** The lines a level's console channel received, in order. */
function linesOn(channel: "error" | "warn" | "info"): string[] {
  const spy = console[channel] as unknown as { mock: { calls: unknown[][] } };
  return spy.mock.calls.map((call) => String(call[0]));
}

function onlyLine(channel: "error" | "warn" | "info"): string {
  const lines = linesOn(channel);
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

function parsedLine(channel: "error" | "warn" | "info"): Record<string, unknown> {
  return JSON.parse(onlyLine(channel)) as Record<string, unknown>;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// -----------------------------------------------------------------------------
// The shape, asserted as a literal
// -----------------------------------------------------------------------------

describe("the emitted line", () => {
  it("is one JSON object whose bytes are exactly this, for a request logger", () => {
    requestLogger("req-abc", { now: CLOCK }).info("started");

    expect(onlyLine("info")).toBe(
      `{"level":"info","time":"${STAMP}","msg":"started","request_id":"req-abc"}`,
    );
  });

  it("is one JSON object whose bytes are exactly this, for a job logger", () => {
    jobLogger("job-9", { now: CLOCK }).info("started");

    expect(onlyLine("info")).toBe(
      `{"level":"info","time":"${STAMP}","msg":"started","job_id":"job-9"}`,
    );
  });

  it("carries request_id and not job_id in a request context, and the reverse in a job", () => {
    requestLogger("req-abc", { now: CLOCK }).info("a");
    jobLogger("job-9", { now: CLOCK }).info("b");

    const [request, job] = linesOn("info").map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );

    expect(request).toMatchObject({ request_id: "req-abc" });
    expect(request).not.toHaveProperty("job_id");
    expect(job).toMatchObject({ job_id: "job-9" });
    expect(job).not.toHaveProperty("request_id");
  });

  it("puts each level on its own console channel, spelled as a literal", () => {
    const log = requestLogger("req-abc", { now: CLOCK });
    log.error("e");
    log.warn("w");
    log.info("i");

    expect(JSON.parse(onlyLine("error"))).toMatchObject({ level: "error", msg: "e" });
    expect(JSON.parse(onlyLine("warn"))).toMatchObject({ level: "warn", msg: "w" });
    expect(JSON.parse(onlyLine("info"))).toMatchObject({ level: "info", msg: "i" });
  });

  it("never emits a raw newline, so one entry is always one line for an aggregator", () => {
    requestLogger("req-abc", { now: CLOCK }).error("boom", {
      err: new Error("multi\nline\nmessage"),
      note: "also\nnewlines",
    });

    const line = onlyLine("error");
    expect(line).not.toContain("\n");
    // ...and the newlines are still THERE, escaped, not stripped.
    expect(
      ((JSON.parse(line) as { err: { message: string } }).err.message),
    ).toBe("multi\nline\nmessage");
  });

  it("takes its timestamp from the injected clock, so two entries can differ", () => {
    let tick = 0;
    const log = requestLogger("req-abc", {
      now: () => new Date(Date.UTC(2026, 0, 2, 3, 4, tick++)),
    });
    log.info("first");
    log.info("second");

    const times = linesOn("info").map((line) => (JSON.parse(line) as { time: string }).time);
    expect(times).toEqual(["2026-01-02T03:04:00.000Z", "2026-01-02T03:04:01.000Z"]);
  });
});

// -----------------------------------------------------------------------------
// The trap: JSON.stringify(new Error("x")) === "{}"
// -----------------------------------------------------------------------------

describe("Error serialization", () => {
  it("is necessary at all: a bare Error stringifies to an empty object", () => {
    // Stated here because it is the exact defect this project already paid for
    // once - a test that passed against a log which had discarded its evidence.
    expect(JSON.stringify(new Error("x"))).toBe("{}");
  });

  it("keeps name, message and stack when an Error is logged as a field", () => {
    const thrown = new TypeError("cannot read properties of undefined");
    requestLogger("req-abc", { now: CLOCK }).error("unhandled", { err: thrown });

    const err = (parsedLine("error") as { err: Record<string, unknown> }).err;
    expect(err.name).toBe("TypeError");
    expect(err.message).toBe("cannot read properties of undefined");
    expect(typeof err.stack).toBe("string");
    expect(String(err.stack)).toContain("TypeError: cannot read properties of undefined");
  });

  it("follows the cause chain, which is where the original fault usually is", () => {
    const root = new Error("ECONNREFUSED 10.0.0.1:5432");
    const wrapper = new Error("could not read the batch", { cause: root });

    requestLogger("req-abc", { now: CLOCK }).error("failed", { err: wrapper });

    const err = (parsedLine("error") as { err: { message: string; cause: { message: string } } })
      .err;
    expect(err.message).toBe("could not read the batch");
    expect(err.cause.message).toBe("ECONNREFUSED 10.0.0.1:5432");
  });

  it("survives an Error nested inside a plain object", () => {
    requestLogger("req-abc", { now: CLOCK }).error("failed", {
      outcome: { attempt: 2, failure: new RangeError("out of range") },
    });

    const parsed = parsedLine("error") as {
      outcome: { failure: { name: string; message: string } };
    };
    expect(parsed.outcome.failure.name).toBe("RangeError");
    expect(parsed.outcome.failure.message).toBe("out of range");
  });

  it("keeps a non-Error throw readable rather than discarding it", () => {
    requestLogger("req-abc", { now: CLOCK }).error("failed", { err: "just a string" });
    expect(parsedLine("error")).toMatchObject({ err: "just a string" });
  });

  it("recognises a cross-realm Error that fails instanceof", () => {
    // A vm context, a worker or a structured-clone boundary produces exactly
    // this: the prototype is foreign, so `instanceof Error` is false, and the
    // properties are non-enumerable exactly as a real Error's are - so the
    // whole `{}` trap applies again to code that only checks instanceof.
    const foreign: Record<string, unknown> = {};
    for (const [key, value] of [
      ["name", "ForeignError"],
      ["message", "from another realm"],
      ["stack", "ForeignError: from another realm\n    at nowhere"],
    ] as const) {
      Object.defineProperty(foreign, key, { value, enumerable: false });
    }
    Object.defineProperty(foreign, Symbol.toStringTag, { value: "Error" });
    expect(JSON.stringify(foreign)).toBe("{}");

    requestLogger("req-abc", { now: CLOCK }).error("failed", { err: foreign });

    expect((parsedLine("error") as { err: Record<string, unknown> }).err).toMatchObject({
      name: "ForeignError",
      message: "from another realm",
      stack: "ForeignError: from another realm\n    at nowhere",
    });
    expect(serializeError(foreign)).toMatchObject({ name: "ForeignError" });
  });

  it("names a cycle through an Error's cause instead of walking it", () => {
    // The exact twin of the plain-object cycle test, on the Error branch -
    // which has its own `seen` bookkeeping and so can be broken independently.
    // A retry wrapper that re-attaches the original error as its own cause
    // produces this for real.
    const looping = new Error("outer") as Error & { cause?: unknown };
    looping.cause = looping;

    expect(() =>
      requestLogger("req-abc", { now: CLOCK }).error("failed", { err: looping }),
    ).not.toThrow();

    const err = (parsedLine("error") as { err: { message: string; cause: unknown } }).err;
    expect(err.message).toBe("outer");
    expect(err.cause).toBe("[circular]");
  });

  it("prints the same Error twice when it is a sibling, not an ancestor", () => {
    const shared = new Error("one fault, two mentions");
    requestLogger("req-abc", { now: CLOCK }).error("failed", {
      batch: { first: shared, second: shared },
    });

    const parsed = parsedLine("error") as {
      batch: { first: { message: string }; second: { message: string } };
    };
    expect(parsed.batch.first.message).toBe("one fault, two mentions");
    expect(parsed.batch.second.message).toBe("one fault, two mentions");
  });

  it("keeps the driver's error code, which is what names the actual fault", () => {
    // PostgREST/Postgres errors are the ones that reach these call sites, and
    // `23505` or `42501` says more than the message does.
    const pgError = Object.assign(new Error('duplicate key value violates "x"'), {
      code: "23505",
    });
    requestLogger("req-abc", { now: CLOCK }).error("failed", { err: pgError });

    expect((parsedLine("error") as { err: Record<string, unknown> }).err).toMatchObject({
      code: "23505",
    });
  });
});

// -----------------------------------------------------------------------------
// Redaction
// -----------------------------------------------------------------------------

describe("redaction", () => {
  it("replaces the value under every key this project treats as secret", () => {
    requestLogger("req-abc", { now: CLOCK }).error("config dump", {
      headers: { authorization: "Bearer sk-live-9999", "x-request-id": "req-abc" },
      access_token: "EAAG-meta-page-token",
      INTEGRATION_TOKEN_AES_KEY: "abcdefghijklmnopqrstuvwxyz012345",
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_do_not_leak",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_public_but_still_a_key",
      qstash_current_signing_key: "sig_abcdef",
      password: "hunter2",
      ciphertext: "AAAA/BBBB==",
    });

    const line = onlyLine("error");
    for (const secret of [
      "sk-live-9999",
      "EAAG-meta-page-token",
      "abcdefghijklmnopqrstuvwxyz012345",
      "sb_secret_do_not_leak",
      "sb_publishable_public_but_still_a_key",
      "sig_abcdef",
      "hunter2",
      "AAAA/BBBB==",
    ]) {
      expect(line).not.toContain(secret);
    }

    const parsed = parsedLine("error") as { headers: Record<string, string> };
    expect(parsed.headers.authorization).toBe("[redacted]");
    // The benign header beside it is untouched - redaction is per key, not
    // per object, so a redacted neighbour must not erase the correlation.
    expect(parsed.headers["x-request-id"]).toBe("req-abc");
  });

  it("leaves the identifiers an operator actually needs to grep for", () => {
    requestLogger("req-abc", { now: CLOCK }).error("failed", {
      route: "receipts.scan",
      user_id: "11111111-2222-3333-4444-555555555555",
      receipt_id: "aaaa-bbbb",
      job_id: "job-9",
      status: 500,
      attempts: 2,
    });

    expect(parsedLine("error")).toMatchObject({
      route: "receipts.scan",
      user_id: "11111111-2222-3333-4444-555555555555",
      receipt_id: "aaaa-bbbb",
      status: 500,
      attempts: 2,
    });
  });

  it("redacts a JWT-shaped value even under a key that looks harmless", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9.c2ln";
    requestLogger("req-abc", { now: CLOCK }).error("failed", { detail: jwt });

    expect(onlyLine("error")).not.toContain(jwt);
    expect(parsedLine("error")).toMatchObject({ detail: "[redacted]" });
  });

  it("redacts a bearer credential even under a key that looks harmless", () => {
    requestLogger("req-abc", { now: CLOCK }).error("failed", {
      detail: "Bearer sb_secret_abcdefghijklmnop",
    });

    expect(onlyLine("error")).not.toContain("sb_secret_abcdefghijklmnop");
  });

  it("redacts a JWT that is INSIDE a URL, which is the realistic leak", () => {
    // A Supabase REST URL is shaped exactly like this. An anchored ^...$ rule
    // sees nothing here, which is how a review probe got a service-role key
    // through: the rule read as protection and provided none for the one case
    // this codebase actually produces.
    const url =
      "https://zlfxfzlnklqhajacngxf.supabase.co/rest/v1/receipts?apikey=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl&select=*";

    requestLogger("req-abc", { now: CLOCK }).error("failed", { endpoint: url });

    expect(onlyLine("error")).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(parsedLine("error")).toMatchObject({ endpoint: "[redacted]" });
  });

  it("redacts a Supabase sb_secret_ key on its own, which matches no other rule", () => {
    requestLogger("req-abc", { now: CLOCK }).error("failed", {
      detail: "sb_secret_abc123DEADBEEF",
    });

    expect(onlyLine("error")).not.toContain("sb_secret_abc123DEADBEEF");
  });

  it("redacts a publishable key too - not a secret, still not log material", () => {
    requestLogger("req-abc", { now: CLOCK }).error("failed", {
      detail: "sb_publishable_abc123DEADBEEF",
    });

    expect(onlyLine("error")).not.toContain("sb_publishable_abc123DEADBEEF");
  });

  it("redacts HTTP Basic, not only Bearer", () => {
    requestLogger("req-abc", { now: CLOCK }).error("failed", {
      detail: "Basic dXNlcjpwYXNzd29yZA==",
    });

    expect(onlyLine("error")).not.toContain("dXNlcjpwYXNzd29yZA==");
  });

  it("redacts an opaque bearer token that is neither a JWT nor a Supabase key", () => {
    requestLogger("req-abc", { now: CLOCK }).error("failed", {
      detail: "Bearer 9f8e7d6c5b4a39281706abcd",
    });

    expect(onlyLine("error")).not.toContain("9f8e7d6c5b4a39281706abcd");
  });

  it("does not eat English prose that happens to contain 'basic' or 'bearer'", () => {
    // REACHABLE, not hypothetical: src/workers/notify/email.ts logs
    // `{ reason: result.reason }`, which is provider text straight from
    // Resend. A rule that swallows a failure reason has destroyed the
    // evidence just as surely as one that lets a token through.
    const prose = {
      a: "basic authentication is disabled for this business",
      b: "the bearer responsible for delivery was unreachable",
      c: "Bearer token missing",
      d: "basic plan limits reached",
    };

    requestLogger("req-abc", { now: CLOCK }).error("failed", prose);

    expect(parsedLine("error")).toMatchObject(prose);
  });

  it("still finds a real credential later in a string that opens with prose", () => {
    // The prose must not shield the token: this checks every match, not the
    // first one.
    requestLogger("req-abc", { now: CLOCK }).error("failed", {
      detail: "basic auth failed, retried with Bearer 9f8e7d6c5b4a39281706abcd",
    });

    expect(onlyLine("error")).not.toContain("9f8e7d6c5b4a39281706abcd");
  });

  it("still leaves an ordinary URL alone", () => {
    // The widened rules must not swallow the field that says WHERE the fault
    // was. Over-redaction is a defect in the other direction.
    requestLogger("req-abc", { now: CLOCK }).error("failed", {
      endpoint: "https://giya.test/api/v1/receipts?select=id&limit=20",
    });

    expect(parsedLine("error")).toMatchObject({
      endpoint: "https://giya.test/api/v1/receipts?select=id&limit=20",
    });
  });

  it("reaches into arrays and nested objects, not just the top level", () => {
    requestLogger("req-abc", { now: CLOCK }).error("failed", {
      connections: [{ page_name: "Giya", page_access_token: "EAAG-secret" }],
    });

    expect(onlyLine("error")).not.toContain("EAAG-secret");
    expect(parsedLine("error")).toMatchObject({
      connections: [{ page_name: "Giya", page_access_token: "[redacted]" }],
    });
  });

  it("is exported on its own so the Sentry hooks scrub with the same rules", () => {
    expect(redact({ authorization: "Bearer x", route: "a" })).toEqual({
      authorization: "[redacted]",
      route: "a",
    });
  });
});

// -----------------------------------------------------------------------------
// Values JSON.stringify cannot handle on its own
// -----------------------------------------------------------------------------

describe("hostile values", () => {
  it("does not throw or lose the entry on a circular structure", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;

    expect(() => requestLogger("req-abc", { now: CLOCK }).error("failed", { cyclic })).not.toThrow();
    expect(parsedLine("error")).toMatchObject({ cyclic: { name: "loop", self: "[circular]" } });
  });

  it("does not throw on a bigint, which JSON.stringify refuses outright", () => {
    // BigInt(...) rather than a `1n` literal: this repo's tsconfig target
    // predates ES2020 and a literal is a compile error (tsc --noEmit is a gate).
    expect(() => JSON.stringify({ n: BigInt(1) })).toThrow();

    requestLogger("req-abc", { now: CLOCK }).info("counted", {
      n: BigInt("9007199254740993"),
    });
    expect(parsedLine("info")).toMatchObject({ n: "9007199254740993" });
  });

  it("turns a Headers instance into its entries rather than an empty object", () => {
    expect(JSON.stringify(new Headers({ "x-a": "1" }))).toBe("{}");

    requestLogger("req-abc", { now: CLOCK }).info("inbound", {
      headers: new Headers({ "x-forwarded-for": "1.2.3.4", authorization: "Bearer nope" }),
    });

    const parsed = parsedLine("info") as { headers: Record<string, string> };
    expect(parsed.headers["x-forwarded-for"]).toBe("1.2.3.4");
    expect(parsed.headers.authorization).toBe("[redacted]");
  });

  it("turns a Map and a Set into something readable rather than an empty object", () => {
    requestLogger("req-abc", { now: CLOCK }).info("state", {
      counts: new Map([["sent", 3]]),
      seen: new Set(["a", "b"]),
    });

    expect(parsedLine("info")).toMatchObject({ counts: { sent: 3 }, seen: ["a", "b"] });
  });

  it("renders a Date, a function, a symbol and a RegExp without dropping the key", () => {
    requestLogger("req-abc", { now: CLOCK }).info("misc", {
      at: new Date("2020-05-06T07:08:09.000Z"),
      fn: () => undefined,
      sym: Symbol("s"),
      pattern: /^[a-z]+$/i,
    });

    expect(parsedLine("info")).toMatchObject({
      at: "2020-05-06T07:08:09.000Z",
      fn: "[function]",
      sym: "[symbol]",
      pattern: "/^[a-z]+$/i",
    });
  });

  it("names an invalid Date rather than emitting null", () => {
    requestLogger("req-abc", { now: CLOCK }).info("misc", { at: new Date("nonsense") });
    expect(parsedLine("info")).toMatchObject({ at: "[invalid date]" });
  });

  it("names NaN and Infinity rather than emitting null", () => {
    // JSON.stringify turns both into `null`, which in a numeric field reads as
    // "absent" and is a different, wrong fact.
    expect(JSON.stringify({ a: NaN, b: Infinity })).toBe('{"a":null,"b":null}');

    requestLogger("req-abc", { now: CLOCK }).info("numbers", { a: NaN, b: Infinity });
    expect(parsedLine("info")).toMatchObject({ a: "NaN", b: "Infinity" });
  });

  it("costs ONE FIELD, not the whole line, when a getter throws", () => {
    // This was a real defect: `Object.entries` invokes getters, so one hostile
    // property unwound past the field loop and the entire entry was lost -
    // no msg, no request_id, not even the sibling that serialized fine.
    // Silently. Which is the exact failure this module exists to prevent,
    // arriving through the module built to prevent it.
    const hostile = {
      safe: "still here",
      get boom(): string {
        throw new Error("getter exploded");
      },
    };

    requestLogger("req-abc", { now: CLOCK }).error("the real fault", { hostile });

    const parsed = parsedLine("error");
    expect(parsed.msg).toBe("the real fault");
    expect(parsed.request_id).toBe("req-abc");
    expect(parsed.hostile).toEqual({ safe: "still here", boom: "[unserializable]" });
  });

  it("costs one field when a TOP-LEVEL field's getter throws", () => {
    const fields = {
      safe: "still here",
      get boom(): string {
        throw new Error("getter exploded");
      },
    };

    requestLogger("req-abc", { now: CLOCK }).error("the real fault", fields);

    expect(parsedLine("error")).toMatchObject({
      msg: "the real fault",
      request_id: "req-abc",
      safe: "still here",
      boom: "[unserializable]",
    });
  });

  it("keeps the line when a Proxy refuses to be enumerated at all", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys exploded");
        },
      },
    );

    requestLogger("req-abc", { now: CLOCK }).error("the real fault", { hostile });

    expect(parsedLine("error")).toMatchObject({
      msg: "the real fault",
      request_id: "req-abc",
      hostile: "[unreadable]",
    });
  });

  it("keeps the line when the TOP-LEVEL field set refuses to be enumerated", () => {
    const fields = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys exploded");
        },
      },
    );

    requestLogger("req-abc", { now: CLOCK }).error("the real fault", fields);

    expect(parsedLine("error")).toMatchObject({
      msg: "the real fault",
      request_id: "req-abc",
      log_error: "fields could not be read",
    });
  });

  it("stops descending at a depth cap instead of walking a deep graph forever", () => {
    let deep: Record<string, unknown> = { bottom: true };
    for (let i = 0; i < 40; i += 1) deep = { next: deep };

    expect(() => requestLogger("req-abc", { now: CLOCK }).info("deep", { deep })).not.toThrow();
    expect(onlyLine("info")).toContain("[truncated]");
  });

  it("caps a long array and says how many it dropped", () => {
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    requestLogger("req-abc", { now: CLOCK }).info("batch", { ids });

    const parsed = parsedLine("info") as { ids: string[] };
    expect(parsed.ids).toHaveLength(51);
    expect(parsed.ids[50]).toBe("[+450 more]");
  });

  it("caps a huge string so one bad field cannot become the outage", () => {
    requestLogger("req-abc", { now: CLOCK }).info("blob", { body: "x".repeat(20_000) });

    const parsed = parsedLine("info") as { body: string };
    expect(parsed.body).toHaveLength(8_192 + "[truncated]".length);
    expect(parsed.body.endsWith("[truncated]")).toBe(true);
  });

  it("prints the same object twice when it is a sibling, not an ancestor", () => {
    // Only an ANCESTOR is a cycle. A shared row object under two keys is
    // ordinary, and reporting it as `[circular]` would hide half the evidence.
    // Nested under ONE field on purpose: each top-level field is walked with
    // its own visited set, so two sibling fields would not exercise this at
    // all. (It did not - a mutant survived here until the test was moved.)
    const shared = { id: "row-1" };
    requestLogger("req-abc", { now: CLOCK }).info("pair", {
      batch: { left: shared, right: shared },
    });

    expect(parsedLine("info")).toMatchObject({
      batch: { left: { id: "row-1" }, right: { id: "row-1" } },
    });
  });
});

// -----------------------------------------------------------------------------
// The correlation guarantee
// -----------------------------------------------------------------------------

describe("correlation", () => {
  it("cannot be overwritten by a field of the same name", () => {
    requestLogger("req-abc", { now: CLOCK }).error("failed", {
      request_id: "attacker-supplied",
      level: "info",
      time: "not a time",
      msg: "not the message",
    });

    expect(onlyLine("error")).toBe(
      `{"level":"error","time":"${STAMP}","msg":"failed","request_id":"req-abc"}`,
    );
  });

  it("marks an entry whose id is blank, so an untraceable line is greppable", () => {
    requestLogger("   ", { now: CLOCK }).error("failed");

    expect(parsedLine("error")).toMatchObject({ correlation_missing: true });
  });

  it("does not let a caller field clear the untraceability marker", () => {
    // The marker is the one field whose whole job is to be inconvenient. A
    // caller-supplied `correlation_missing: false` erasing it would let the
    // untraceable lines hide themselves.
    requestLogger("   ", { now: CLOCK }).error("failed", { correlation_missing: false });

    expect(parsedLine("error")).toMatchObject({ correlation_missing: true });
  });

  it("does not mark an entry that has a real id", () => {
    requestLogger("req-abc", { now: CLOCK }).error("failed");
    expect(parsedLine("error")).not.toHaveProperty("correlation_missing");
  });

  it("keeps the id, and the bound fields, on a derived logger", () => {
    const log = requestLogger("req-abc", { now: CLOCK }).with({ route: "receipts.scan" });
    log.error("first");
    log.error("second", { attempt: 2 });

    const [first, second] = linesOn("error").map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(first).toMatchObject({ request_id: "req-abc", route: "receipts.scan", msg: "first" });
    expect(second).toMatchObject({
      request_id: "req-abc",
      route: "receipts.scan",
      msg: "second",
      attempt: 2,
    });
  });

  it("redacts the fields bound by with(), not only the ones passed at the call", () => {
    requestLogger("req-abc", { now: CLOCK }).with({ authorization: "Bearer nope" }).error("failed");
    expect(onlyLine("error")).not.toContain("nope");
  });

  it("does not let a hostile bound field throw out of with() itself", () => {
    // `{ ...bound, ...fields }` read every getter EAGERLY, at with() time,
    // outside every guard in this module - so the throw escaped a logger
    // CONSTRUCTOR into a catch block already handling a fault. Strictly worse
    // than the bug the per-field guards were added to fix: that one cost the
    // line, this one cost the caller.
    const hostile = {
      safe: "still here",
      get boom(): string {
        throw new Error("bound getter exploded");
      },
    };

    let log: ReturnType<typeof requestLogger> | undefined;
    expect(() => {
      log = requestLogger("req-abc", { now: CLOCK }).with(hostile);
    }).not.toThrow();

    log!.error("the real fault");

    expect(parsedLine("error")).toMatchObject({
      msg: "the real fault",
      request_id: "req-abc",
      safe: "still here",
      boom: "[unserializable]",
    });
  });

  it("does not let a bound field set that refuses enumeration throw out of with()", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys exploded");
        },
      },
    );

    let log: ReturnType<typeof requestLogger> | undefined;
    expect(() => {
      log = requestLogger("req-abc", { now: CLOCK }).with(hostile);
    }).not.toThrow();

    log!.error("the real fault");

    expect(parsedLine("error")).toMatchObject({
      msg: "the real fault",
      request_id: "req-abc",
      log_error: "bound fields could not be read",
    });
  });
});

// -----------------------------------------------------------------------------
// The request id, in one place
// -----------------------------------------------------------------------------

describe("resolveRequestId", () => {
  it("keeps a well-formed inbound id, so end-to-end correlation survives", () => {
    expect(resolveRequestId("client-abc-0123456789")).toBe("client-abc-0123456789");
  });

  it("replaces anything that is not one, rather than echoing it", () => {
    for (const hostile of [
      null,
      undefined,
      "",
      "short",
      'evil","level":"info","msg":"forged',
      "a".repeat(65),
      "has spaces",
      "semi;colon",
    ]) {
      const resolved = resolveRequestId(hostile);
      expect(resolved).not.toBe(hostile);
      expect(REQUEST_ID_PATTERN.test(resolved)).toBe(true);
    }
  });

  it("produces an id that its own screen would accept, with Web Crypto", () => {
    expect(typeof globalThis.crypto.randomUUID).toBe("function");
    expect(REQUEST_ID_PATTERN.test(resolveRequestId(null))).toBe(true);
  });

  it("produces an id that its own screen would accept, without Web Crypto", () => {
    // A runtime with no `crypto.randomUUID` must not yield a blank or
    // malformed id - the next hop screens it and would throw it away, and a
    // request that loses its id at the first boundary is untraceable from
    // there on.
    const original = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
      const generated = resolveRequestId(null);
      expect(REQUEST_ID_PATTERN.test(generated)).toBe(true);
      expect(generated).not.toBe(resolveRequestId(null));
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });
});

// -----------------------------------------------------------------------------
// Which deploy
// -----------------------------------------------------------------------------

describe("deploy identity", () => {
  it("stamps the commit sha when the platform provides one", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "aeeaaa5deadbeef");
    requestLogger("req-abc", { now: CLOCK }).info("started");
    expect(parsedLine("info")).toMatchObject({ release: "aeeaaa5deadbeef" });
  });

  it("omits the key entirely off-platform rather than emitting a null", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    requestLogger("req-abc", { now: CLOCK }).info("started");
    expect(parsedLine("info")).not.toHaveProperty("release");
  });
});

// -----------------------------------------------------------------------------
// A logger must never be the reason something fails
// -----------------------------------------------------------------------------

describe("robustness", () => {
  it("swallows a sink that throws rather than replacing the fault being logged", () => {
    const write = vi.fn(() => {
      throw new Error("stdout is gone");
    });

    expect(() =>
      requestLogger("req-abc", { now: CLOCK, write }).error("the real fault"),
    ).not.toThrow();
    // Twice: the entry, then the minimal fallback. Both failed, and that is
    // the end of it - a third attempt would be a loop.
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("falls back to a minimal line when the full entry cannot be serialized", () => {
    const lines: string[] = [];
    const write = vi.fn((_level: string, line: string) => {
      // Fail only the first, full entry - as a sink with a size limit would.
      if (lines.length === 0 && line.length > 200) {
        lines.push(line);
        throw new Error("line too long");
      }
      lines.push(line);
    });

    requestLogger("req-abc", { now: CLOCK, write }).error("the real fault", {
      blob: "x".repeat(400),
    });

    const fallback = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(fallback).toEqual({
      level: "error",
      time: STAMP,
      msg: "the real fault",
      request_id: "req-abc",
      log_error: "entry could not be serialized",
    });
  });

  it("still emits a correlated line when the clock throws", () => {
    // Losing the timestamp must not lose the entry. The aggregator stamps its
    // own receipt time anyway; nothing else can reconstruct the request id.
    requestLogger("req-abc", {
      now: () => {
        throw new Error("no clock");
      },
    }).error("the real fault");

    expect(parsedLine("error")).toMatchObject({
      msg: "the real fault",
      request_id: "req-abc",
      log_error: "clock unavailable",
    });
  });

  it("writes through an injected sink instead of the console when one is given", () => {
    const write = vi.fn();
    requestLogger("req-abc", { now: CLOCK, write }).warn("careful");

    expect(write).toHaveBeenCalledWith(
      "warn",
      `{"level":"warn","time":"${STAMP}","msg":"careful","request_id":"req-abc"}`,
    );
    expect(linesOn("warn")).toEqual([]);
  });
});
