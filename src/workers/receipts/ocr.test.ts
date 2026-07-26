// @vitest-environment node
//
// The `ocr.process` worker's one real decision: turning a pipeline that never
// throws and never returns anything into a retry verdict.
//
// The mapping is the whole subject. `processReceipt` reports nothing - not a
// value, not an exception - so the only evidence of what happened is
// `receipts.status`, and getting the reading backwards is expensive in both
// directions: a rejected receipt retried until its budget is gone, or a
// recoverable one abandoned to a 24-hour sweep.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runOcrProcess } from "./ocr";
import type { OcrProcessDeps } from "./ocr";

const RECEIPT_ID = "0198f0a1-0000-7000-8000-0000000000aa";
const JOB_ID = "0198f0a1-0000-7000-8000-000000000001";
const PAYLOAD = { job_id: JOB_ID, receipt_id: RECEIPT_ID };

interface StatusAnswer {
  data: { status: string } | null;
  error: { message: string } | null;
}

/** The one query this worker makes, plus a record of what it asked for. */
function fakeSupabase(answer: StatusAnswer) {
  const asked: Array<{ table: string; column: string; value: unknown }> = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          return {
            eq(column: string, value: unknown) {
              asked.push({ table: `${table}.${columns}`, column, value });
              return { maybeSingle: async () => answer };
            },
          };
        },
      };
    },
  };
  return { client: client as unknown as OcrProcessDeps["supabase"], asked };
}

function deps(answer: StatusAnswer, processReceipt = vi.fn(async () => undefined)) {
  const { client, asked } = fakeSupabase(answer);
  return { deps: { supabase: client, processReceipt }, processReceipt, asked };
}

function ok(status: string): StatusAnswer {
  return { data: { status }, error: null };
}

function mute(): void {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}

describe("runOcrProcess - it runs the pipeline", () => {
  it("hands the receipt id to processReceipt and nothing else", async () => {
    mute();
    const t = deps(ok("approved"));

    await runOcrProcess(PAYLOAD, t.deps);

    expect(t.processReceipt).toHaveBeenCalledExactlyOnceWith(RECEIPT_ID);
  });

  it("reads the outcome off the receipt row, not off the return value", async () => {
    mute();
    const t = deps(ok("approved"));

    await runOcrProcess(PAYLOAD, t.deps);

    expect(t.asked).toEqual([{ table: "receipts.status", column: "id", value: RECEIPT_ID }]);
  });
});

describe("runOcrProcess - terminal outcomes are acked", () => {
  // Doc 36's state machine: these three are final, and `processReceipt` would
  // refuse to touch such a receipt again anyway (Stage 2's ack-and-exit).
  it.each(["approved", "review", "rejected"])("reports '%s' as terminal", async (status) => {
    mute();
    const t = deps(ok(status));

    await expect(runOcrProcess(PAYLOAD, t.deps)).resolves.toEqual({ kind: "terminal", status });
  });

  // The one worth naming on its own. Doc 39, `ocr.process` failure notes: an
  // unreadable image is "a *successful* job with a negative domain outcome, not
  // a job failure". Reading it as a failure would retry a decision the platform
  // correctly made until the attempt budget was gone, and then fill the DLQ
  // with receipts that were properly refused.
  it("treats a REJECTED receipt as a job that succeeded", async () => {
    mute();
    const t = deps(ok("rejected"));

    const result = await runOcrProcess(PAYLOAD, t.deps);

    expect(result.kind).toBe("terminal");
    expect(result.kind === "terminal" && result.status).toBe("rejected");
  });
});

describe("runOcrProcess - unfinished outcomes ask for another delivery", () => {
  // `handleOcrFailure` parks a receipt at 'processing' on purpose for an OCR
  // 503, a timeout, and for wrong OCR credentials. Doc 36 Stage 2 names
  // 'processing' retry-eligible for exactly this reason.
  it("reports 'processing' as retryable", async () => {
    mute();
    const t = deps(ok("processing"));

    await expect(runOcrProcess(PAYLOAD, t.deps)).resolves.toEqual({
      kind: "retryable",
      status: "processing",
    });
  });

  // The pipeline never even claimed the row: no service-role key, a
  // misconfigured OCR provider, a read that failed. All recoverable.
  it("reports 'queued' as retryable", async () => {
    mute();
    const t = deps(ok("queued"));

    await expect(runOcrProcess(PAYLOAD, t.deps)).resolves.toEqual({
      kind: "retryable",
      status: "queued",
    });
  });

  // The real shape of the misconfigured-deployment case: processReceipt with
  // null deps returns immediately having done nothing at all, and the receipt
  // is untouched. Acking that would abandon it.
  it("asks for a retry when the pipeline was a no-op", async () => {
    mute();
    const t = deps(ok("queued"), vi.fn(async () => undefined));

    const result = await runOcrProcess(PAYLOAD, t.deps);

    expect(t.processReceipt).toHaveBeenCalled();
    expect(result.kind).toBe("retryable");
  });
});

describe("runOcrProcess - the branches that are not a status", () => {
  it("reports a receipt that does not exist as gone", async () => {
    mute();
    const t = deps({ data: null, error: null });

    await expect(runOcrProcess(PAYLOAD, t.deps)).resolves.toEqual({ kind: "gone" });
  });

  // Nothing is known, including whether the pipeline ran. The safe direction is
  // one wasted delivery that finds a terminal receipt and acks it.
  it("asks for a retry when the status query fails", async () => {
    mute();
    const t = deps({ data: null, error: { message: "connection reset" } });

    await expect(runOcrProcess(PAYLOAD, t.deps)).resolves.toEqual({
      kind: "unreadable",
      reason: "connection reset",
    });
  });

  // processReceipt is documented not to throw, so this is a fault in the
  // wiring rather than in a receipt - and it must not escape, because the route
  // would then answer 500 by accident rather than by decision.
  it("never throws, and asks for a retry when processReceipt does", async () => {
    mute();
    const t = deps(
      ok("approved"),
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );

    await expect(runOcrProcess(PAYLOAD, t.deps)).resolves.toEqual({
      kind: "unreadable",
      reason: "processReceipt threw",
    });
  });
});
