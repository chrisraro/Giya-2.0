// @vitest-environment node
//
// The money path's worker route, and the two things only an end-to-end test of
// it can prove:
//
//   1. NOTHING HAPPENS BEFORE THE SIGNATURE IS CHECKED. An unverified request
//      must not reach the service-role client, the claim, or the pipeline - and
//      it must be told nothing about why it was refused.
//   2. THE STATUS CODE IS A RETRY DECISION. QStash retries 5xx and stops on
//      2xx. A receipt that reached a terminal state must produce a 2xx even
//      though nothing was awarded; a receipt that is legitimately retryable
//      must produce a 5xx. Getting this backwards either retries a rejected
//      receipt until its budget is gone or abandons a recoverable one.

import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const SIGNING_KEY = "sig_route_test_key";
const ORIGIN = "https://giya.example";
const PATH = "/api/jobs/ocr.process";

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

const heartbeatStop = vi.fn();
const startHeartbeat = vi.fn();
vi.mock("@/lib/queue/heartbeat", () => ({
  startHeartbeat: (args: unknown) => startHeartbeat(args),
}));

const runOcrProcess = vi.fn();
vi.mock("@/workers/receipts/ocr", () => ({
  runOcrProcess: (...args: unknown[]) => runOcrProcess(...(args as [])),
}));

// The real pipeline is never imported into the test's reach, but the route
// imports it to hand it to the worker; stubbed so nothing pulls in sharp, the
// OCR provider or Redis.
const processReceipt = vi.fn(async () => undefined);
vi.mock("@/features/receipts/server/process", () => ({
  processReceipt: (...args: unknown[]) => processReceipt(...(args as [])),
}));

import { bodyHash } from "@/lib/queue/verify";
import { QUEUE_REGISTRY } from "@/lib/queue/queues";

import { POST, maxDuration } from "./route";

const JOB_ID = "0198f0a1-0000-7000-8000-000000000001";
const RECEIPT_ID = "0198f0a1-0000-7000-8000-0000000000aa";

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

const VALID_BODY = JSON.stringify({ job_id: JOB_ID, receipt_id: RECEIPT_ID });

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
      queue: "ocr.process",
      status: "running",
      payload: { receipt_id: RECEIPT_ID },
      businessId: null,
      attempts: 1,
      maxAttempts: 3,
    },
  });
  runOcrProcess.mockResolvedValue({ kind: "terminal", status: "approved" });
  startHeartbeat.mockReturnValue({ stop: heartbeatStop });
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
    expect(maxDuration).toBe(QUEUE_REGISTRY["ocr.process"].maxDurationSeconds);
    expect(maxDuration).toBe(120);
  });
});

describe("an unverified request", () => {
  // THE FORGERY, end to end. A well-formed token with every claim right, signed
  // with a key we do not hold.
  it("is refused with a bare 401 and does no work at all", async () => {
    const response = await post(VALID_BODY, sign(VALID_BODY, "sig_the_attacker_made_this_up"));

    expect(response.status).toBe(401);
    // No body, so there is no reason to read. Four different rejection reasons
    // are four facts about our configuration.
    expect(await response.text()).toBe("");
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(claimJob).not.toHaveBeenCalled();
    expect(runOcrProcess).not.toHaveBeenCalled();
    expect(processReceipt).not.toHaveBeenCalled();
    expect(finishJob).not.toHaveBeenCalled();
  });

  it("is refused when the signature header is missing entirely", async () => {
    const response = await post(VALID_BODY, null);
    expect(response.status).toBe(401);
    expect(claimJob).not.toHaveBeenCalled();
    expect(runOcrProcess).not.toHaveBeenCalled();
  });

  // The body swap: a genuine captured signature replayed over a payload of the
  // attacker's choosing - here, someone else's receipt id.
  it("is refused when the body does not match the signed hash", async () => {
    const signature = sign(VALID_BODY);
    const swapped = JSON.stringify({
      job_id: JOB_ID,
      receipt_id: "0198f0a1-0000-7000-8000-0000000000ff",
    });
    const response = await post(swapped, signature);

    expect(response.status).toBe(401);
    expect(runOcrProcess).not.toHaveBeenCalled();
  });

  // A signature minted for the OTHER worker route. verify.ts pins the
  // destination path, so a message for notify.email cannot be replayed here.
  it("is refused when the signature was issued for another queue", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const claims = base64Url(
      JSON.stringify({
        iss: "Upstash",
        sub: `${ORIGIN}/api/jobs/notify.email`,
        exp: nowSeconds + 300,
        nbf: nowSeconds - 1,
        jti: "msg_cross_queue",
        body: bodyHash(VALID_BODY),
      }),
    );
    const input = `${header}.${claims}`;
    const crossQueue = `${input}.${createHmac("sha256", SIGNING_KEY).update(input).digest("base64url")}`;

    expect((await post(VALID_BODY, crossQueue)).status).toBe(401);
    expect(runOcrProcess).not.toHaveBeenCalled();
  });

  // 401 is not a retry decision, so it must not be a 5xx: QStash would
  // otherwise keep re-delivering a message it can never get accepted.
  it("is never answered with a retryable status", async () => {
    const response = await post(VALID_BODY, "garbage");
    expect(response.status).toBeLessThan(500);
  });
});

describe("a verified request", () => {
  it("claims the job, runs the pipeline and records success", async () => {
    const response = await post(VALID_BODY, sign(VALID_BODY));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "approved" });
    expect(claimJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID, queue: "ocr.process" }),
    );
    expect(runOcrProcess).toHaveBeenCalledWith(
      { job_id: JOB_ID, receipt_id: RECEIPT_ID },
      expect.objectContaining({ supabase: serviceClient }),
    );
    expect(finishJob).toHaveBeenCalledWith(serviceClient, JOB_ID, 1, { kind: "succeeded" });
  });

  it("hands the real pipeline to the worker", async () => {
    await post(VALID_BODY, sign(VALID_BODY));

    const passed = runOcrProcess.mock.calls[0]?.[1] as { processReceipt: unknown };
    expect(typeof passed.processReceipt).toBe("function");
  });

  // Doc 39's taxonomy: a Zod failure is TERMINAL. The third delivery carries
  // the same bytes.
  it("marks a malformed payload dead and does not ask for a retry", async () => {
    const bad = JSON.stringify({ job_id: JOB_ID, receipt_id: "not-a-uuid" });
    const response = await post(bad, sign(bad));

    expect(response.status).toBe(200);
    expect(runOcrProcess).not.toHaveBeenCalled();
    // No claim was made for this delivery - it never got past payload
    // parsing - so there is no lease to guard the write on.
    expect(finishJob).toHaveBeenCalledWith(serviceClient, JOB_ID, null, {
      kind: "dead",
      error: "payload failed schema validation",
    });
  });

  it("answers 200 to a body that is not JSON at all", async () => {
    const response = await post("not json", sign("not json"));
    expect(response.status).toBe(200);
    expect(claimJob).not.toHaveBeenCalled();
  });
});

describe("terminal outcomes stop the retries", () => {
  // The decision this route exists to get right. A receipt the platform
  // correctly refused is a job that SUCCEEDED, so QStash must be told to stop.
  it.each(["approved", "review", "rejected"])(
    "answers 200 and records success when the receipt is '%s'",
    async (status) => {
      runOcrProcess.mockResolvedValue({ kind: "terminal", status });
      const response = await post(VALID_BODY, sign(VALID_BODY));

      expect(response.status).toBe(200);
      expect(finishJob).toHaveBeenCalledWith(serviceClient, JOB_ID, 1, { kind: "succeeded" });
    },
  );

  it("answers 200 and marks the job dead when the receipt does not exist", async () => {
    runOcrProcess.mockResolvedValue({ kind: "gone" });
    const response = await post(VALID_BODY, sign(VALID_BODY));

    expect(response.status).toBe(200);
    // `dead`, not `succeeded`: nothing was processed, and the operator should
    // see it in the DLQ view.
    expect(finishJob).toHaveBeenCalledWith(serviceClient, JOB_ID, 1, {
      kind: "dead",
      error: "receipt does not exist",
    });
  });
});

describe("a lost lease", () => {
  // t2-8: this invocation was reclaimed by another while it was still
  // running - finishJob(...) resolves "lease-lost" rather than writing
  // anything. The route must not turn that into a retry: the reclaiming
  // invocation now owns the row and will report its own outcome, so asking
  // QStash to redeliver would only run the work a third time.
  it("does not turn a lease-lost outcome into a retryable response", async () => {
    finishJob.mockResolvedValueOnce({ kind: "lease-lost" });
    const response = await post(VALID_BODY, sign(VALID_BODY));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "approved" });
  });
});

describe("retryable outcomes ask for another delivery", () => {
  // The other half of the decision. The pipeline parks a receipt at
  // 'processing' precisely because another attempt could still save it.
  it.each(["processing", "queued"])(
    "answers 5xx and leaves the job claimable when the receipt is still '%s'",
    async (status) => {
      runOcrProcess.mockResolvedValue({ kind: "retryable", status });
      const response = await post(VALID_BODY, sign(VALID_BODY));

      expect(response.status).toBeGreaterThanOrEqual(500);
      // `failed`, not `dead`, so the claim predicate lets the next delivery in.
      expect(finishJob).toHaveBeenCalledWith(
        serviceClient,
        JOB_ID,
        1,
        expect.objectContaining({ kind: "failed" }),
      );
    },
  );

  it("asks for a retry when the outcome could not be read", async () => {
    runOcrProcess.mockResolvedValue({ kind: "unreadable", reason: "connection reset" });
    const response = await post(VALID_BODY, sign(VALID_BODY));

    expect(response.status).toBe(503);
    expect(finishJob).toHaveBeenCalledWith(
      serviceClient,
      JOB_ID,
      1,
      expect.objectContaining({ kind: "failed" }),
    );
  });

  it("asks for a retry when the claim itself could not conclude", async () => {
    claimJob.mockResolvedValue({ status: "error", reason: "connection reset" });
    const response = await post(VALID_BODY, sign(VALID_BODY));

    expect(response.status).toBe(503);
    expect(runOcrProcess).not.toHaveBeenCalled();
  });

  it("asks for a retry when the worker throws unexpectedly", async () => {
    runOcrProcess.mockRejectedValue(new Error("boom"));
    const response = await post(VALID_BODY, sign(VALID_BODY));

    expect(response.status).toBe(503);
    expect(finishJob).toHaveBeenCalledWith(
      serviceClient,
      JOB_ID,
      1,
      expect.objectContaining({ kind: "failed" }),
    );
  });

  // The work has not been done and nothing is touched, so a later delivery
  // against a configured deployment does exactly the right thing.
  it("asks for a retry when there is no service-role client", async () => {
    createServiceRoleClient.mockReturnValueOnce(null as never);
    const response = await post(VALID_BODY, sign(VALID_BODY));

    expect(response.status).toBe(503);
    expect(claimJob).not.toHaveBeenCalled();
    expect(runOcrProcess).not.toHaveBeenCalled();
  });
});

describe("the heartbeat", () => {
  // t2-6: a claimed job must refresh heartbeat_at for exactly the window the
  // handler is actually running, so a stalled worker can be told apart from a
  // slow one - and never any longer than that.
  it("starts only after the job is claimed, with this invocation's own ownership predicate", async () => {
    await post(VALID_BODY, sign(VALID_BODY));

    expect(startHeartbeat).toHaveBeenCalledTimes(1);
    expect(startHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ supabase: serviceClient, jobId: JOB_ID, attempts: 1 }),
    );
    // Started strictly after claimJob resolved and before the pipeline ran -
    // an interval covering work that has not started yet would tick against
    // nothing, and one started after the pipeline returns would miss the
    // whole window it exists to cover.
    const claimOrder = claimJob.mock.invocationCallOrder[0];
    const startOrder = startHeartbeat.mock.invocationCallOrder[0];
    const runOrder = runOcrProcess.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(startOrder as number);
    expect(startOrder).toBeLessThan(runOrder as number);
  });

  // Each of the next three tests asserts ORDER, not just call count.
  // `expect(heartbeatStop).toHaveBeenCalledTimes(1)` alone passes whether
  // `stop()` runs in the route's `finally` (correct) or on the line right
  // after `startHeartbeat` (which would disable heartbeating entirely and
  // still leave every one of these assertions green) - the two are only
  // told apart by proving the pipeline call and the outcome write both
  // happened BEFORE `stop()`.
  it("stops after the pipeline succeeds, only after the pipeline actually ran and the outcome was recorded", async () => {
    await post(VALID_BODY, sign(VALID_BODY));

    expect(heartbeatStop).toHaveBeenCalledTimes(1);
    const runOrder = runOcrProcess.mock.invocationCallOrder[0] as number;
    const finishOrder = finishJob.mock.invocationCallOrder[0] as number;
    const stopOrder = heartbeatStop.mock.invocationCallOrder[0] as number;
    expect(runOrder).toBeLessThan(stopOrder);
    expect(finishOrder).toBeLessThan(stopOrder);
  });

  it("stops after a retryable outcome, only after the outcome was recorded", async () => {
    runOcrProcess.mockResolvedValue({ kind: "retryable", status: "processing" });
    await post(VALID_BODY, sign(VALID_BODY));

    expect(heartbeatStop).toHaveBeenCalledTimes(1);
    const finishOrder = finishJob.mock.invocationCallOrder[0] as number;
    const stopOrder = heartbeatStop.mock.invocationCallOrder[0] as number;
    expect(finishOrder).toBeLessThan(stopOrder);
  });

  it("stops even when the handler throws, only after the failure was recorded", async () => {
    runOcrProcess.mockRejectedValue(new Error("boom"));
    await post(VALID_BODY, sign(VALID_BODY));

    expect(heartbeatStop).toHaveBeenCalledTimes(1);
    const runOrder = runOcrProcess.mock.invocationCallOrder[0] as number;
    const finishOrder = finishJob.mock.invocationCallOrder[0] as number;
    const stopOrder = heartbeatStop.mock.invocationCallOrder[0] as number;
    expect(runOrder).toBeLessThan(stopOrder);
    expect(finishOrder).toBeLessThan(stopOrder);
  });

  it.each(["done", "held", "exhausted", "missing"] as const)(
    "never starts when the claim result is '%s' - there is no handler running to heartbeat for",
    async (status) => {
      claimJob.mockResolvedValue(
        status === "done" ? { status, jobStatus: "succeeded" } : { status },
      );
      await post(VALID_BODY, sign(VALID_BODY));
      expect(startHeartbeat).not.toHaveBeenCalled();
      expect(heartbeatStop).not.toHaveBeenCalled();
    },
  );

  // Requirement 3 ("a refresh failure must never fail the job") is
  // categorical, and it covers even `startHeartbeat` itself throwing
  // synchronously - not just a refresh failing later. The pipeline must still
  // run and the job must still be reported on its own merits, heartbeat-less.
  it("still runs the pipeline and reports its real outcome when starting the heartbeat itself throws", async () => {
    startHeartbeat.mockImplementationOnce(() => {
      throw new Error("setInterval exploded");
    });

    const response = await post(VALID_BODY, sign(VALID_BODY));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "approved" });
    expect(runOcrProcess).toHaveBeenCalledTimes(1);
    expect(finishJob).toHaveBeenCalledWith(serviceClient, JOB_ID, 1, { kind: "succeeded" });
    // The fallback handle's own stop() is a fresh no-op, not the shared
    // `heartbeatStop` mock - so this only asserts nothing blew up on the way
    // to a real, correctly-reported outcome.
  });
});

describe("duplicate delivery", () => {
  it("answers 200 without running the pipeline when the job already succeeded", async () => {
    claimJob.mockResolvedValue({ status: "done", jobStatus: "succeeded" });
    const response = await post(VALID_BODY, sign(VALID_BODY));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: true });
    expect(runOcrProcess).not.toHaveBeenCalled();
  });

  it("answers 200 when another invocation owns the job", async () => {
    claimJob.mockResolvedValue({ status: "held" });
    const response = await post(VALID_BODY, sign(VALID_BODY));

    expect(response.status).toBe(200);
    expect(runOcrProcess).not.toHaveBeenCalled();
  });

  // Retrying is the one thing already proved not to work. The receipt is left
  // for `sweep_stuck_receipts` (0028) rather than dead-lettered here, so two
  // writers never race to declare the same receipt dead.
  it("answers 200 when the job exhausted its attempts", async () => {
    claimJob.mockResolvedValue({ status: "exhausted" });

    expect((await post(VALID_BODY, sign(VALID_BODY))).status).toBe(200);
    expect(runOcrProcess).not.toHaveBeenCalled();
  });

  it("answers 200 for a job row that does not exist", async () => {
    claimJob.mockResolvedValue({ status: "missing" });
    expect((await post(VALID_BODY, sign(VALID_BODY))).status).toBe(200);
  });
});
