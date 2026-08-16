import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";

import { mapSubmitError, networkError, type ReceiptSubmissionOutcome } from "../receipts/upload";
import { listOutboxItems, putOutboxItem, type OutboxItem } from "./outbox";
import {
  OUTBOX_BACKOFF_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_SYNC_TAG,
  backoffMsForAttempts,
  classifyReplayOutcome,
  createBackoffSchedule,
  drainOutbox,
  isOutboxSyncTag,
  registerOutboxSync,
  type OutboxReplayEvent,
  type SubmitReceipt,
} from "./outbox-replay";
import {
  OUTBOX_ALREADY_SENT_MESSAGE,
  OUTBOX_FAILED_MESSAGE,
  OUTBOX_TERMINAL_MESSAGE,
  OUTBOX_UPLOADED_MESSAGE,
} from "./outbox-copy";

// Same seam as outbox.test.ts, for the same reason: the drain is asserted
// against a REAL IndexedDB, so "the row was deleted" and "the attempt count
// survived" mean what they say. Only the network is a double, and it is a
// double of `submitCapturedReceipt`, whose real outcome shapes are built here
// through the real `mapSubmitError`/`networkError` rather than hand-written.
function receiptBlob(bytes = "jpeg-bytes"): Blob {
  return new NodeBlob([bytes], { type: "image/jpeg" }) as unknown as Blob;
}

function row(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: "row-1",
    image: receiptBlob(),
    client_sha256: "a".repeat(64),
    business_id: "3f1b0d9c-4444-4444-8444-444444444444",
    captured_at: "2026-08-16T09:00:00.000Z",
    idempotency_key: "22222222-2222-4222-8222-222222222222",
    attempts: 0,
    last_error: null,
    status: "queued",
    ...overrides,
  };
}

const ACCEPTED: ReceiptSubmissionOutcome = {
  ok: true,
  receiptId: "receipt-1",
  status: "queued",
  imagePath: "u/1.jpg",
};

function failure(
  status: number,
  code: string | undefined,
  retryAfterSeconds?: number,
): ReceiptSubmissionOutcome {
  return {
    ok: false,
    error: mapSubmitError(status, code, undefined, retryAfterSeconds),
    imagePath: null,
  };
}

function transportFailure(offline: boolean): ReceiptSubmissionOutcome {
  return { ok: false, error: networkError(offline), imagePath: null };
}

const NOW = Date.parse("2026-08-16T10:00:00.000Z");

function harness(outcomes: ReceiptSubmissionOutcome[]) {
  const submit = vi.fn() as ReturnType<typeof vi.fn> & SubmitReceipt;
  for (const outcome of outcomes) submit.mockResolvedValueOnce(outcome);
  const events: OutboxReplayEvent[] = [];
  const schedule = createBackoffSchedule();
  let clock = NOW;
  return {
    submit,
    events,
    schedule,
    setNow: (at: number) => {
      clock = at;
    },
    deps: {
      submit: submit as SubmitReceipt,
      now: () => clock,
      schedule,
      notify: (event: OutboxReplayEvent) => events.push(event),
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("navigator", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("replay classification (doc 41 section 3)", () => {
  it("treats a 202 as sent", () => {
    expect(classifyReplayOutcome(ACCEPTED).kind).toBe("sent");
  });

  it("treats RECEIPT_DUPLICATE as already sent, never as a failure", () => {
    // Doc 41 section 3 step 4: the server dedupes on an authoritative
    // server-computed sha256, so a double submit cannot award twice and a
    // duplicate on replay means the receipt is already filed.
    expect(classifyReplayOutcome(failure(422, "RECEIPT_DUPLICATE")).kind).toBe("already-sent");
  });

  it("treats IDEMPOTENCY_REPLAYED as already sent", () => {
    // The drain re-presigns, so a replay whose original POST did reach the
    // server carries a different image_path under the same key and is answered
    // 409 IDEMPOTENCY_REPLAYED. That answer only exists because the original
    // submission exists, so it is success-already-processed too.
    expect(classifyReplayOutcome(failure(409, "IDEMPOTENCY_REPLAYED")).kind).toBe("already-sent");
  });

  it("makes a 4xx domain answer terminal immediately", () => {
    expect(classifyReplayOutcome(failure(403, "CONSUMER_SCAN_BLOCKED")).kind).toBe("terminal");
    expect(classifyReplayOutcome(failure(422, "RECEIPT_INVALID_IMAGE")).kind).toBe("terminal");
    // An unmapped 400. This is the case a kind-only classifier gets wrong:
    // mapSubmitError falls back to kind "unknown" with retryable: true, which
    // is right for a Try again button and wrong for an unattended drain.
    expect(classifyReplayOutcome(failure(400, "VALIDATION_FAILED")).kind).toBe("terminal");
  });

  it("retries a 409 IDEMPOTENCY_IN_PROGRESS even though it is a 4xx", () => {
    // The first request under this key has not finished. Waiting is exactly
    // what works, so this must not fall into the 4xx-is-terminal branch.
    expect(classifyReplayOutcome(failure(409, "IDEMPOTENCY_IN_PROGRESS")).kind).toBe("retry");
  });

  it("retries a 5xx and a transport failure", () => {
    expect(classifyReplayOutcome(failure(503, "DEPENDENCY_UNAVAILABLE")).kind).toBe("retry");
    expect(classifyReplayOutcome(transportFailure(false)).kind).toBe("retry");
  });

  it("pauses without spending an attempt when the device is offline", () => {
    // submitCapturedReceipt returns this BEFORE it fetches anything, so no
    // attempt was made. Counting it would burn all five attempts over five
    // launches with no signal and mark every receipt failed without one of them
    // ever having been sent.
    const disposition = classifyReplayOutcome(transportFailure(true));
    expect(disposition.kind).toBe("pause");
  });

  it("pauses without spending an attempt when the session has expired", () => {
    // Nothing in the queue can succeed signed out, and spending attempts on it
    // would delete the consumer's queue for a session they can just renew.
    expect(classifyReplayOutcome(failure(401, "UNAUTHENTICATED")).kind).toBe("pause");
  });

  it("spends an attempt on RATE_LIMITED and carries its Retry-After", () => {
    const disposition = classifyReplayOutcome(failure(429, "RATE_LIMITED", 90));
    expect(disposition.kind).toBe("retry");
    expect(disposition.kind === "retry" && disposition.pauseSeconds).toBe(90);
  });
});

describe("replay backoff (doc 41 section 3 step 3)", () => {
  it("is 30s, 2m, 10m then 1h", () => {
    // Literals, not the module's own array: an expectation that reads the value
    // it checks cannot disagree with the code.
    expect(backoffMsForAttempts(1)).toBe(30_000);
    expect(backoffMsForAttempts(2)).toBe(120_000);
    expect(backoffMsForAttempts(3)).toBe(600_000);
    expect(backoffMsForAttempts(4)).toBe(3_600_000);
    expect([...OUTBOX_BACKOFF_MS]).toEqual([30_000, 120_000, 600_000, 3_600_000]);
    expect(OUTBOX_MAX_ATTEMPTS).toBe(5);
  });
});

describe("drain", () => {
  it("sends FIFO by captured_at, deletes the row and says the receipt is uploading", async () => {
    await putOutboxItem(row({ id: "later", captured_at: "2026-08-16T09:05:00.000Z" }));
    await putOutboxItem(row({ id: "earlier", captured_at: "2026-08-16T09:01:00.000Z" }));
    const h = harness([ACCEPTED, ACCEPTED]);

    await drainOutbox(h.deps);

    expect(h.submit.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey))
      .toHaveLength(2);
    expect(h.events.filter((event) => event.type === "sent")).toHaveLength(2);
    expect(h.events[0]?.id).toBe("earlier");
    expect(h.events[0]?.message).toBe("Receipt uploaded. We are processing it now.");
    expect(h.events[0]?.message).toBe(OUTBOX_UPLOADED_MESSAGE);
    expect(await listOutboxItems()).toHaveLength(0);
  });

  it("replays the STORED Idempotency-Key and client hash, across a restart", async () => {
    // The whole reason the key is a stored column. A key minted at replay time
    // would file a second receipt for the same purchase the first time a drain
    // ran twice, which is precisely what an outbox makes likely.
    await putOutboxItem(
      row({ idempotency_key: "9f9f9f9f-1111-4111-8111-999999999999", client_sha256: "b".repeat(64) }),
    );
    vi.resetModules();
    const fresh = await import("./outbox-replay");
    const h = harness([ACCEPTED]);

    await fresh.drainOutbox(h.deps);

    const input = h.submit.mock.calls[0]?.[0] as {
      idempotencyKey: string;
      clientSha256: string | undefined;
      businessId: string | undefined;
      imagePath: string | null | undefined;
    };
    expect(input.idempotencyKey).toBe("9f9f9f9f-1111-4111-8111-999999999999");
    expect(input.clientSha256).toBe("b".repeat(64));
    expect(input.businessId).toBe("3f1b0d9c-4444-4444-8444-444444444444");
    // No path is carried over: the row stores none, so the drain presigns.
    expect(input.imagePath ?? null).toBeNull();
  });

  it("sends a generic scan with no business rather than a literal null", async () => {
    await putOutboxItem(row({ business_id: null, client_sha256: null }));
    const h = harness([ACCEPTED]);

    await drainOutbox(h.deps);

    const input = h.submit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.businessId).toBeUndefined();
    expect(input.clientSha256).toBeUndefined();
  });

  it("removes a duplicate with an informational message, not an error", async () => {
    await putOutboxItem(row());
    const h = harness([failure(422, "RECEIPT_DUPLICATE")]);

    await drainOutbox(h.deps);

    expect(await listOutboxItems()).toHaveLength(0);
    expect(h.events[0]?.type).toBe("already-sent");
    expect(h.events[0]?.message).toBe(
      "That receipt had already reached us, so we took it off your queue.",
    );
    expect(h.events[0]?.message).toBe(OUTBOX_ALREADY_SENT_MESSAGE);
  });

  it("removes a 4xx domain refusal without ever retrying it", async () => {
    await putOutboxItem(row());
    const h = harness([failure(403, "CONSUMER_SCAN_BLOCKED")]);

    await drainOutbox(h.deps);

    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(await listOutboxItems()).toHaveLength(0);
    expect(h.events[0]?.type).toBe("terminal");
    expect(h.events[0]?.message).toBe(OUTBOX_TERMINAL_MESSAGE);
  });

  it("counts a network failure, keeps the receipt, and holds it for 30 seconds", async () => {
    await putOutboxItem(row());
    const h = harness([transportFailure(false)]);

    await drainOutbox(h.deps);

    const [item] = await listOutboxItems();
    expect(item?.attempts).toBe(1);
    expect(item?.status).toBe("queued");
    expect(item?.last_error).toBe("network");

    // Not due yet, one second short of the 30s step.
    h.setNow(NOW + 29_000);
    await drainOutbox(h.deps);
    expect(h.submit).toHaveBeenCalledTimes(1);

    // Due. The clock moves FORWARD past the step, never back inside it.
    h.submit.mockResolvedValueOnce(ACCEPTED);
    h.setNow(NOW + 30_001);
    await drainOutbox(h.deps);
    expect(h.submit).toHaveBeenCalledTimes(2);
    expect(await listOutboxItems()).toHaveLength(0);
  });

  it("marks the row failed on the fifth attempt and KEEPS the receipt", async () => {
    await putOutboxItem(row({ attempts: 4 }));
    const h = harness([transportFailure(false)]);

    await drainOutbox(h.deps);

    const [item] = await listOutboxItems();
    // The receipt is still on the phone. Doc 41 section 8: the outbox is the
    // one thing on the device that is not safe to lose, so exhausting the
    // automatic retries hands it to the manual Retry button, it does not throw
    // the photo away.
    expect(item).toBeDefined();
    expect(item?.status).toBe("failed");
    expect(item?.attempts).toBe(5);
    expect(h.events[0]?.type).toBe("failed");
    expect(h.events[0]?.message).toBe(OUTBOX_FAILED_MESSAGE);
  });

  it("leaves a failed row alone until somebody retries it by hand", async () => {
    await putOutboxItem(row({ attempts: 5, status: "failed", last_error: "network" }));
    const h = harness([ACCEPTED]);

    await drainOutbox(h.deps);

    expect(h.submit).not.toHaveBeenCalled();
    expect(await listOutboxItems()).toHaveLength(1);
  });

  it("picks up a row stranded in uploading by a killed attempt", async () => {
    // The tab was closed mid-attempt. Excluding `uploading` from the drain (as
    // doc 41's sketch does) would strand that receipt on the phone forever with
    // no automatic path out, and the Idempotency-Key already makes re-sending
    // it safe.
    await putOutboxItem(row({ status: "uploading", attempts: 1 }));
    const h = harness([ACCEPTED]);

    await drainOutbox(h.deps);

    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(await listOutboxItems()).toHaveLength(0);
  });

  it("pauses the WHOLE drain on RATE_LIMITED instead of skipping ahead", async () => {
    // Doc 41 section 3: "RATE_LIMITED honors Retry-After before the next item -
    // the whole drain pauses, preserving FIFO." Moving to item two would both
    // break capture order and spend the next second of a budget the server has
    // already said is empty.
    await putOutboxItem(row({ id: "first", captured_at: "2026-08-16T09:01:00.000Z" }));
    await putOutboxItem(row({ id: "second", captured_at: "2026-08-16T09:02:00.000Z" }));
    const h = harness([failure(429, "RATE_LIMITED", 120), ACCEPTED, ACCEPTED]);

    const result = await drainOutbox(h.deps);

    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(result.paused).toBe(true);
    expect(result.pauseSeconds).toBe(120);
    expect(await listOutboxItems()).toHaveLength(2);

    // And the pause is honoured: a drain inside the window sends nothing, even
    // for the item that was never attempted.
    h.setNow(NOW + 119_000);
    await drainOutbox(h.deps);
    expect(h.submit).toHaveBeenCalledTimes(1);

    h.setNow(NOW + 121_000);
    await drainOutbox(h.deps);
    expect(h.submit).toHaveBeenCalledTimes(3);
  });

  it("stops without spending an attempt when the device is offline", async () => {
    await putOutboxItem(row({ id: "first", captured_at: "2026-08-16T09:01:00.000Z" }));
    await putOutboxItem(row({ id: "second", captured_at: "2026-08-16T09:02:00.000Z" }));
    const h = harness([transportFailure(true), transportFailure(true)]);

    await drainOutbox(h.deps);

    expect(h.submit).toHaveBeenCalledTimes(1);
    const items = await listOutboxItems();
    expect(items.map((item) => item.attempts)).toEqual([0, 0]);
    expect(items.map((item) => item.status)).toEqual(["queued", "queued"]);
  });

  it("does nothing at all, and never throws, when the outbox cannot be read", async () => {
    // A drain runs unattended on app launch. A browser with no IndexedDB must
    // cost the consumer an inert no-op, not an unhandled rejection.
    vi.stubGlobal("indexedDB", undefined);
    const h = harness([ACCEPTED]);

    const result = await drainOutbox(h.deps);

    expect(result.sent).toBe(0);
    expect(h.submit).not.toHaveBeenCalled();
  });
});

describe("background sync tag (doc 41 section 6)", () => {
  it("is receipt-outbox, and no other tag drains the queue", () => {
    expect(OUTBOX_SYNC_TAG).toBe("receipt-outbox");
    expect(isOutboxSyncTag("receipt-outbox")).toBe(true);
    expect(isOutboxSyncTag("wallet-refresh")).toBe(false);
    expect(isOutboxSyncTag(undefined)).toBe(false);
  });

  it("registers the tag on a browser that supports Background Sync", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const container = { ready: Promise.resolve({ sync: { register } }) };

    const registered = await registerOutboxSync(container as unknown as ServiceWorkerContainer);

    expect(registered).toBe(true);
    expect(register).toHaveBeenCalledWith("receipt-outbox");
  });

  it("reports false, without throwing, on iOS Safari and Firefox Android", async () => {
    // Doc 41 section 6: one-shot Background Sync is unsupported on both. The
    // registration object simply has no `sync`, which is the feature detection
    // the spec asks for and not a user-agent guess. The fallback replays carry
    // the queue on those browsers, so this answer must not read as a failure.
    const container = { ready: Promise.resolve({}) };

    expect(await registerOutboxSync(container as unknown as ServiceWorkerContainer)).toBe(false);
  });

  it("reports false when there is no service worker container at all", async () => {
    expect(await registerOutboxSync(undefined)).toBe(false);
  });

  it("reports false when the browser refuses the registration", async () => {
    const container = {
      ready: Promise.resolve({ sync: { register: vi.fn().mockRejectedValue(new Error("denied")) } }),
    };

    expect(await registerOutboxSync(container as unknown as ServiceWorkerContainer)).toBe(false);
  });
});
