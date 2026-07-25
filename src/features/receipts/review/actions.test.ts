// @vitest-environment node
//
// The two server actions. Thin by design, so what is pinned here is exactly
// what this layer owns: the ACTOR ID comes from the session and never from the
// payload, no business id is ever passed (the service derives the tenant from
// the receipt), the paths that show the pending count are revalidated, and the
// service's typed error codes reach the screen intact so
// RECEIPT_NOT_REVIEWABLE can be rendered as news rather than as a failure.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));

const mocks = vi.hoisted(() => ({
  reviewReceipt: vi.fn(),
  resolveReviewerContext: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("../server/review", () => ({ reviewReceipt: mocks.reviewReceipt }));
vi.mock("./access", () => ({ resolveReviewerContext: mocks.resolveReviewerContext }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { approveReceiptAction, rejectReceiptAction } from "./actions";

const RECEIPT_ID = "01980000-0000-7000-8000-000000000001";
const MANAGER_ID = "01980000-0000-7000-8000-0000000000a1";
const BUSINESS_ID = "01980000-0000-7000-8000-0000000000b1";

const REVIEWER = {
  userId: MANAGER_ID,
  businessId: BUSINESS_ID,
  businessName: "Sari Sari Express",
  role: "manager" as const,
};

const FIELDS = {
  merchant_name: "SARI SARI EXPRESS",
  receipt_number: "0012345",
  receipt_date: "2026-07-24T00:00:00.000Z",
  subtotal_centavos: 16_964,
  tax_centavos: 2_036,
  total_centavos: 19_000,
};

beforeEach(() => {
  mocks.reviewReceipt.mockReset();
  mocks.resolveReviewerContext.mockReset();
  mocks.revalidatePath.mockReset();
  mocks.resolveReviewerContext.mockResolvedValue(REVIEWER);
});

describe("approveReceiptAction", () => {
  it("calls reviewReceipt with the session's actor id and the reviewer's fields", async () => {
    mocks.reviewReceipt.mockResolvedValue({
      ok: true,
      status: "approved",
      award: { kind: "awarded", points: 190, transactionId: "tx" },
    });

    const result = await approveReceiptAction({ receiptId: RECEIPT_ID, fields: FIELDS });

    expect(result).toEqual({ ok: true, status: "approved", pointsAwarded: 190 });
    expect(mocks.reviewReceipt).toHaveBeenCalledTimes(1);

    const call = mocks.reviewReceipt.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.receiptId).toBe(RECEIPT_ID);
    expect(call.actorId).toBe(MANAGER_ID);
    expect(call.action).toBe("approve");
    expect(call.fields).toEqual(FIELDS);
    expect(typeof call.requestId).toBe("string");
    // No business id crosses this boundary: the service takes the tenant from
    // the receipt, so a caller cannot widen their scope by naming one.
    expect(call).not.toHaveProperty("businessId");
  });

  it("ignores an actor id supplied by the caller", async () => {
    mocks.reviewReceipt.mockResolvedValue({
      ok: true,
      status: "approved",
      award: { kind: "skipped_zero_points" },
    });

    await approveReceiptAction({
      receiptId: RECEIPT_ID,
      fields: FIELDS,
      actorId: "someone-else",
      businessId: "another-business",
    });

    const call = mocks.reviewReceipt.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.actorId).toBe(MANAGER_ID);
    expect(call).not.toHaveProperty("businessId");
  });

  it("reports a zero-point or refused award as no points rather than as zero", async () => {
    mocks.reviewReceipt.mockResolvedValue({
      ok: true,
      status: "approved",
      award: { kind: "skipped_zero_points" },
    });

    const result = await approveReceiptAction({ receiptId: RECEIPT_ID, fields: FIELDS });
    expect(result).toEqual({ ok: true, status: "approved", pointsAwarded: null });
  });

  it("revalidates the queue, the decision and the dashboard tile", async () => {
    mocks.reviewReceipt.mockResolvedValue({
      ok: true,
      status: "approved",
      award: { kind: "awarded", points: 10, transactionId: null },
    });

    await approveReceiptAction({ receiptId: RECEIPT_ID, fields: FIELDS });

    expect(mocks.revalidatePath.mock.calls.map((call) => call[0])).toEqual([
      "/business/receipts",
      `/business/receipts/${RECEIPT_ID}`,
      "/business/dashboard",
    ]);
  });

  it("passes the service's refusal code through untouched", async () => {
    mocks.reviewReceipt.mockResolvedValue({
      ok: false,
      code: "RECEIPT_NOT_REVIEWABLE",
      message: "That receipt has already been decided. Refresh the queue.",
      fieldErrors: [],
    });

    const result = await approveReceiptAction({ receiptId: RECEIPT_ID, fields: FIELDS });

    expect(result).toEqual({
      ok: false,
      code: "RECEIPT_NOT_REVIEWABLE",
      message: "That receipt has already been decided. Refresh the queue.",
      fieldErrors: [],
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("surfaces the self-review refusal the service raises", async () => {
    mocks.reviewReceipt.mockResolvedValue({
      ok: false,
      code: "FORBIDDEN",
      message: "You cannot decide a receipt you submitted yourself.",
      fieldErrors: [],
    });

    const result = await approveReceiptAction({ receiptId: RECEIPT_ID, fields: FIELDS });
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("refuses before touching the service when the caller cannot review", async () => {
    mocks.resolveReviewerContext.mockResolvedValue(null);

    const result = await approveReceiptAction({ receiptId: RECEIPT_ID, fields: FIELDS });

    expect(result).toMatchObject({ ok: false, code: "NOT_ALLOWED" });
    expect(mocks.reviewReceipt).not.toHaveBeenCalled();
  });

  it("refuses a receipt id that is not a uuid", async () => {
    const result = await approveReceiptAction({ receiptId: "../../etc", fields: FIELDS });

    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(mocks.reviewReceipt).not.toHaveBeenCalled();
  });
});

describe("rejectReceiptAction", () => {
  it("passes the reason and the note straight to the service", async () => {
    mocks.reviewReceipt.mockResolvedValue({
      ok: true,
      status: "rejected",
      reason: "fraud_suspected",
    });

    const result = await rejectReceiptAction({
      receiptId: RECEIPT_ID,
      reason: "fraud_suspected",
      note: "Same photo as yesterday",
    });

    expect(result).toEqual({ ok: true, status: "rejected", reason: "fraud_suspected" });

    const call = mocks.reviewReceipt.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.action).toBe("reject");
    expect(call.actorId).toBe(MANAGER_ID);
    expect(call.rejectReason).toBe("fraud_suspected");
    expect(call.rejectNote).toBe("Same photo as yesterday");
  });

  it("omits rejectNote entirely when there is no note", async () => {
    mocks.reviewReceipt.mockResolvedValue({
      ok: true,
      status: "rejected",
      reason: "unreadable",
    });

    await rejectReceiptAction({ receiptId: RECEIPT_ID, reason: "unreadable" });

    const call = mocks.reviewReceipt.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("rejectNote");
  });

  it("lets the service reject an invalid reason rather than guessing one here", async () => {
    mocks.reviewReceipt.mockResolvedValue({
      ok: false,
      code: "RECEIPT_FIELDS_INVALID",
      message: "Choose a rejection reason.",
      fieldErrors: ["rejectReason: Invalid option"],
    });

    const result = await rejectReceiptAction({ receiptId: RECEIPT_ID, reason: "not_a_reason" });

    expect(result).toMatchObject({ ok: false, code: "RECEIPT_FIELDS_INVALID" });
    // The action forwarded it: one schema decides what a valid reason is.
    expect(mocks.reviewReceipt).toHaveBeenCalledTimes(1);
  });

  it("refuses when the caller cannot review", async () => {
    mocks.resolveReviewerContext.mockResolvedValue(null);

    const result = await rejectReceiptAction({ receiptId: RECEIPT_ID, reason: "unreadable" });

    expect(result).toMatchObject({ ok: false, code: "NOT_ALLOWED" });
    expect(mocks.reviewReceipt).not.toHaveBeenCalled();
  });
});
