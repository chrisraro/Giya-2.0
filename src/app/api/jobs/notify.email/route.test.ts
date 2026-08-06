// @vitest-environment node
//
// The worker route, and the two things only an end-to-end test of it can prove:
//
//   1. NOTHING HAPPENS BEFORE THE SIGNATURE IS CHECKED. An unverified request
//      must not reach the service-role client, the claim, or the sender - and
//      it must be told nothing about why it was refused.
//   2. THE STATUS CODE IS A RETRY DECISION. QStash retries 5xx and stops on
//      2xx, so every branch that another delivery cannot improve has to answer
//      200 even when the news is bad.

import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const SIGNING_KEY = "sig_route_test_key";
const ORIGIN = "https://giya.example";
const PATH = "/api/jobs/notify.email";

vi.mock("@/lib/env", () => ({
  env: {},
  getServerEnv: () => ({
    QSTASH_CURRENT_SIGNING_KEY: "sig_route_test_key",
    QSTASH_CALLBACK_ORIGIN: "https://giya.example",
  }),
}));

const serviceClient = { marker: "service-role" };
const createServiceRoleClient = vi.fn(() => serviceClient as never);
vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

type FinishResult = { kind: "recorded" } | { kind: "lease-lost" } | { kind: "error"; reason: string };

const claimJob = vi.fn();
const finishJob = vi.fn(async (): Promise<FinishResult> => ({ kind: "recorded" }));
vi.mock("@/lib/queue/claim", () => ({
  claimJob: (args: unknown) => claimJob(args),
  finishJob: (...args: unknown[]) => finishJob(...(args as [])),
}));

const runNotifyEmail = vi.fn();
vi.mock("@/workers/notify/email", () => ({
  runNotifyEmail: (...args: unknown[]) => runNotifyEmail(...(args as [])),
}));

import { bodyHash } from "@/lib/queue/verify";
import { QUEUE_REGISTRY } from "@/lib/queue/queues";

import { POST, maxDuration } from "./route";

const JOB_ID = "0198f0a1-0000-7000-8000-000000000001";
const NOTIFICATION_ID = "0198f0a1-0000-7000-8000-0000000000aa";

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function sign(rawBody: string, key = SIGNING_KEY): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: "Upstash",
      sub: `${ORIGIN}${PATH}`,
      exp: nowSeconds + 300,
      nbf: nowSeconds - 1,
      jti: "msg_route_test",
      body: bodyHash(rawBody),
    }),
  );
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${createHmac("sha256", key).update(signingInput).digest("base64url")}`;
}

function request(rawBody: string, signature: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["upstash-signature"] = signature;
  return new Request(`${ORIGIN}${PATH}`, { method: "POST", headers, body: rawBody });
}

const VALID_BODY = JSON.stringify({
  job_id: JOB_ID,
  notification_ids: [NOTIFICATION_ID],
});

// The route's parameter is typed as NextRequest; a plain Request carries
// everything it actually touches (headers and the body stream), so the cast is
// the honest way to exercise it without a Next server.
const post = (rawBody: string, signature: string | null) =>
  POST(request(rawBody, signature) as never);

beforeEach(() => {
  claimJob.mockResolvedValue({
    status: "claimed",
    job: {
      id: JOB_ID,
      queue: "notify.email",
      status: "running",
      payload: {},
      businessId: null,
      attempts: 1,
      maxAttempts: 5,
    },
  });
  runNotifyEmail.mockResolvedValue({ sent: 1, skipped: 0, failedTerminal: 0, failedRetryable: 0 });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("the route's timeout budget", () => {
  // Next reads `maxDuration` as a static literal, so the route cannot compute
  // it from the registry. This is what keeps the two in step.
  it("matches doc 39's budget for this queue", () => {
    expect(maxDuration).toBe(QUEUE_REGISTRY["notify.email"].maxDurationSeconds);
    expect(maxDuration).toBe(60);
  });
});

describe("an unverified request", () => {
  // THE FORGERY, end to end. A well-formed token with every claim right, signed
  // with a key we do not hold.
  it("is refused with a bare 401 and reaches nothing", async () => {
    const response = await post(VALID_BODY, sign(VALID_BODY, "sig_the_attacker_made_this_up"));

    expect(response.status).toBe(401);
    // No body at all, so there is no reason to read. Four different rejection
    // reasons are four facts about our configuration, and handing them to
    // whoever is probing turns a closed door into an oracle.
    expect(await response.text()).toBe("");
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(claimJob).not.toHaveBeenCalled();
    expect(runNotifyEmail).not.toHaveBeenCalled();
    expect(finishJob).not.toHaveBeenCalled();
  });

  it("is refused when the signature header is missing entirely", async () => {
    const response = await post(VALID_BODY, null);
    expect(response.status).toBe(401);
    expect(claimJob).not.toHaveBeenCalled();
  });

  // The body swap: a genuine captured signature replayed over a payload of the
  // attacker's choosing. Without the `body` claim check the signature would
  // authenticate the token rather than the request.
  it("is refused when the body does not match the signed hash", async () => {
    const signature = sign(VALID_BODY);
    const swapped = JSON.stringify({
      job_id: "0198f0a1-0000-7000-8000-0000000000ff",
      notification_ids: [NOTIFICATION_ID],
    });
    const response = await post(swapped, signature);
    expect(response.status).toBe(401);
    expect(claimJob).not.toHaveBeenCalled();
  });

  // 401 is not a retry decision, so it must not be a 5xx: QStash would
  // otherwise keep re-delivering a message it can never get accepted.
  it("is never answered with a retryable status", async () => {
    const response = await post(VALID_BODY, "garbage");
    expect(response.status).toBeLessThan(500);
  });
});

describe("a verified request", () => {
  it("claims the job, runs the batch and records success", async () => {
    const response = await post(VALID_BODY, sign(VALID_BODY));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, sent: 1 });
    expect(claimJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID, queue: "notify.email" }),
    );
    expect(runNotifyEmail).toHaveBeenCalledWith(
      { job_id: JOB_ID, notification_ids: [NOTIFICATION_ID] },
      expect.objectContaining({ supabase: serviceClient }),
    );
    expect(finishJob).toHaveBeenCalledWith(serviceClient, JOB_ID, 1, { kind: "succeeded" });
  });

  // Doc 39's taxonomy: a Zod failure is TERMINAL. The fifth delivery carries
  // the same bytes, so the row is marked dead and the answer is 200.
  it("marks a malformed payload dead and does not ask for a retry", async () => {
    const bad = JSON.stringify({ job_id: JOB_ID, notification_ids: "not an array" });
    const response = await post(bad, sign(bad));

    expect(response.status).toBe(200);
    expect(runNotifyEmail).not.toHaveBeenCalled();
    // No claim was made for this delivery - it never got past payload
    // parsing - so there is no lease to guard the write on.
    expect(finishJob).toHaveBeenCalledWith(serviceClient, JOB_ID, null, {
      kind: "dead",
      error: "payload failed schema validation",
    });
  });

  it("refuses an empty batch, which is a publisher bug rather than a no-op", async () => {
    const empty = JSON.stringify({ job_id: JOB_ID, notification_ids: [] });
    const response = await post(empty, sign(empty));
    expect(response.status).toBe(200);
    expect(runNotifyEmail).not.toHaveBeenCalled();
    expect(finishJob).toHaveBeenCalledWith(
      serviceClient,
      JOB_ID,
      null,
      expect.objectContaining({ kind: "dead" }),
    );
  });

  it("answers 200 to a body that is not JSON at all", async () => {
    const response = await post("not json", sign("not json"));
    expect(response.status).toBe(200);
    expect(claimJob).not.toHaveBeenCalled();
  });
});

describe("duplicate delivery", () => {
  // Doc 39: an already-succeeded job is an idempotent no-op, and it is a 200 so
  // QStash stops asking.
  it("answers 200 without running anything when the job already succeeded", async () => {
    claimJob.mockResolvedValue({ status: "done", jobStatus: "succeeded" });
    const response = await post(VALID_BODY, sign(VALID_BODY));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: true });
    expect(runNotifyEmail).not.toHaveBeenCalled();
  });

  it("answers 200 when another invocation owns the job", async () => {
    claimJob.mockResolvedValue({ status: "held" });
    const response = await post(VALID_BODY, sign(VALID_BODY));
    expect(response.status).toBe(200);
    expect(runNotifyEmail).not.toHaveBeenCalled();
  });

  // Retrying is the one thing already proved not to work, so asking for another
  // delivery would only fill the DLQ with noise.
  it("answers 200 when the job exhausted its attempts", async () => {
    claimJob.mockResolvedValue({ status: "exhausted" });
    expect((await post(VALID_BODY, sign(VALID_BODY))).status).toBe(200);
    expect(runNotifyEmail).not.toHaveBeenCalled();
  });

  it("answers 200 for a job row that does not exist", async () => {
    claimJob.mockResolvedValue({ status: "missing" });
    expect((await post(VALID_BODY, sign(VALID_BODY))).status).toBe(200);
  });
});

describe("a lost lease", () => {
  // t2-8: notify.email has no heartbeat wiring, so it always takes isStale's
  // `2 * maxDuration` fallback arm - a reclaim there provably cannot race a
  // live worker. The lease guard is still exercised on every finishJob call,
  // though, and must remain a no-op that never turns into a retry even if it
  // somehow reported "lease-lost".
  it("does not turn a lease-lost outcome into a retryable response", async () => {
    finishJob.mockResolvedValueOnce({ kind: "lease-lost" });
    const response = await post(VALID_BODY, sign(VALID_BODY));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });
});

describe("retryable outcomes", () => {
  // The rows are still pending, so the next delivery finds them and the ones
  // already sent stay 'sent'. `failed` rather than `dead` so the claim
  // predicate lets that delivery through.
  it("asks QStash to retry when a send failed in a way another attempt could fix", async () => {
    runNotifyEmail.mockResolvedValue({ sent: 0, skipped: 0, failedTerminal: 0, failedRetryable: 1 });
    const response = await post(VALID_BODY, sign(VALID_BODY));

    expect(response.status).toBe(503);
    expect(finishJob).toHaveBeenCalledWith(
      serviceClient,
      JOB_ID,
      1,
      expect.objectContaining({ kind: "failed" }),
    );
  });

  // A terminal per-row failure is recorded on the row, not on the job: the job
  // did its work, and the outcome for that recipient is final.
  it("reports success when every failure was terminal", async () => {
    runNotifyEmail.mockResolvedValue({ sent: 0, skipped: 0, failedTerminal: 1, failedRetryable: 0 });
    const response = await post(VALID_BODY, sign(VALID_BODY));
    expect(response.status).toBe(200);
    expect(finishJob).toHaveBeenCalledWith(serviceClient, JOB_ID, 1, { kind: "succeeded" });
  });

  it("asks for a retry when the claim itself could not conclude", async () => {
    claimJob.mockResolvedValue({ status: "error", reason: "connection reset" });
    const response = await post(VALID_BODY, sign(VALID_BODY));
    expect(response.status).toBe(503);
    expect(runNotifyEmail).not.toHaveBeenCalled();
  });

  it("asks for a retry when the worker throws unexpectedly", async () => {
    runNotifyEmail.mockRejectedValue(new Error("boom"));
    const response = await post(VALID_BODY, sign(VALID_BODY));
    expect(response.status).toBe(503);
    expect(finishJob).toHaveBeenCalledWith(
      serviceClient,
      JOB_ID,
      1,
      expect.objectContaining({ kind: "failed" }),
    );
  });

  // The work has not been done and the row is untouched, so a later delivery
  // against a configured deployment does exactly the right thing.
  it("asks for a retry when there is no service-role client", async () => {
    createServiceRoleClient.mockReturnValueOnce(null as never);
    const response = await post(VALID_BODY, sign(VALID_BODY));
    expect(response.status).toBe(503);
    expect(claimJob).not.toHaveBeenCalled();
  });
});
