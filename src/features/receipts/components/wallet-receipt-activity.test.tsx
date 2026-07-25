import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReceiptListItemDTO } from "../types";

// The wallet's pending receipt entry, end to end through its lifecycle:
// inserted with NO points amount, then flipped by a Realtime event to
// confirmed-with-points, being-reviewed, or the rejection reason.
//
// This is doc 36's "optimistic wallet UX" contract, and the assertion that
// matters most is the negative one: at no point before the ledger row exists
// does the wallet display a number.

interface ChannelConfig {
  event: string;
  schema: string;
  table: string;
  filter: string;
}

const mocks = vi.hoisted(() => ({
  configs: [] as ChannelConfig[],
  changeHandlers: [] as ((payload: { new?: unknown }) => void)[],
  subscribeCallbacks: [] as ((status: string) => void)[],
  removeChannel: vi.fn(),
  fetchReceiptDetail: vi.fn(),
  fetchMyReceipts: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const channel = {
      on(_event: string, config: ChannelConfig, handler: (payload: { new?: unknown }) => void) {
        mocks.configs.push(config);
        mocks.changeHandlers.push(handler);
        return channel;
      },
      subscribe(callback: (status: string) => void) {
        mocks.subscribeCallbacks.push(callback);
        return channel;
      },
    };
    return { channel: () => channel, removeChannel: mocks.removeChannel };
  },
}));

vi.mock("./receipt-api-client", () => ({
  fetchReceiptDetail: mocks.fetchReceiptDetail,
  fetchMyReceipts: mocks.fetchMyReceipts,
}));

const { WalletReceiptActivity, WALLET_RECEIPT_LIMIT } = await import("./wallet-receipt-activity");

const USER_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ID = "11111111-1111-4111-8111-111111111111";

function receipt(overrides: Partial<ReceiptListItemDTO> = {}): ReceiptListItemDTO {
  return {
    receiptId: RECEIPT_ID,
    businessId: "22222222-2222-4222-8222-222222222222",
    businessName: "Kape Diaria",
    status: "queued",
    rejectReason: null,
    merchantName: null,
    receiptNumber: null,
    receiptDate: null,
    totalCentavos: null,
    createdAt: "2026-07-25T03:15:00.000Z",
    processedAt: null,
    pointsAwarded: null,
    ...overrides,
  };
}

function emitChange(row: Record<string, unknown>): void {
  act(() => {
    for (const handler of mocks.changeHandlers) handler({ new: { id: RECEIPT_ID, ...row } });
  });
}

function renderWallet(initial: ReceiptListItemDTO[]) {
  return render(<WalletReceiptActivity userId={USER_ID} initialReceipts={initial} />);
}

beforeEach(() => {
  mocks.configs.length = 0;
  mocks.changeHandlers.length = 0;
  mocks.subscribeCallbacks.length = 0;
  mocks.removeChannel.mockClear();
  mocks.fetchReceiptDetail.mockReset();
  mocks.fetchMyReceipts.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the pending entry", () => {
  it("appears as 'Processing receipt' the moment the submission exists", () => {
    renderWallet([receipt({ status: "queued" })]);

    expect(screen.getByRole("heading", { name: "Receipts" })).toBeInTheDocument();
    expect(screen.getByText(/Processing receipt/)).toBeInTheDocument();
  });

  it("CRITICAL: carries NO points amount, because the amount is unknown until parse", () => {
    renderWallet([receipt({ status: "processing", pointsAwarded: null, totalCentavos: null })]);

    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/pts\b/);
    expect(text).not.toMatch(/\+\s*\d/);
    expect(text).not.toMatch(/\bpoints\b/i);
  });

  it("links through to the live status screen", () => {
    renderWallet([receipt()]);
    expect(screen.getByRole("link", { name: /Processing receipt/ })).toHaveAttribute(
      "href",
      `/scan/${RECEIPT_ID}`,
    );
  });

  it("renders nothing at all when the consumer has never scanned", () => {
    const { container } = renderWallet([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows at most the strip's limit and defers the rest to /receipts", () => {
    const many = Array.from({ length: WALLET_RECEIPT_LIMIT + 2 }, (_unused, index) =>
      receipt({ receiptId: `receipt-${index}`, status: "approved", pointsAwarded: 10 + index }),
    );

    renderWallet(many);

    expect(screen.getAllByRole("listitem")).toHaveLength(WALLET_RECEIPT_LIMIT);
    expect(screen.getByRole("link", { name: "See all" })).toHaveAttribute("href", "/receipts");
  });
});

describe("the flip", () => {
  it("subscribes scoped to the caller's own receipts", () => {
    renderWallet([receipt({ status: "queued" })]);

    expect(mocks.configs[0]).toEqual({
      event: "UPDATE",
      schema: "public",
      table: "receipts",
      filter: `user_id=eq.${USER_ID}`,
    });
  });

  it("flips to confirmed WITH points on approval, fetching the figure from the ledger-backed endpoint", async () => {
    mocks.fetchReceiptDetail.mockResolvedValue(
      receipt({ status: "approved", pointsAwarded: 245, processedAt: "2026-07-25T03:15:40.000Z" }),
    );

    renderWallet([receipt({ status: "processing" })]);
    emitChange({ status: "approved" });

    // Label flips immediately; the number arrives only once it is real.
    expect(screen.getByText(/Points added/)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("+245 pts")).toBeInTheDocument());
    expect(mocks.fetchReceiptDetail).toHaveBeenCalledWith(RECEIPT_ID);
  });

  it("never shows a points number between the approval event and the ledger read", () => {
    // Detail fetch that never resolves: the entry must sit at "Points added"
    // with no figure rather than inventing one.
    mocks.fetchReceiptDetail.mockReturnValue(new Promise(() => {}));

    renderWallet([receipt({ status: "processing" })]);
    emitChange({ status: "approved" });

    expect(screen.getByText(/Points added/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\+\s*\d/);
  });

  it("flips to 'Being reviewed by the store' on review", () => {
    renderWallet([receipt({ status: "processing" })]);

    emitChange({ status: "review" });

    expect(screen.getByText(/Being reviewed by the store/)).toBeInTheDocument();
    expect(mocks.fetchReceiptDetail).not.toHaveBeenCalled();
  });

  it("flips to the consumer-safe rejection reason on rejection", () => {
    renderWallet([receipt({ status: "processing" })]);

    emitChange({ status: "rejected", reject_reason: "duplicate" });

    expect(screen.getByText(/Already scanned/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("duplicate");
  });

  it("shows no fraud vocabulary when a receipt is rejected as fraud_suspected", () => {
    renderWallet([receipt({ status: "processing" })]);

    emitChange({ status: "rejected", reject_reason: "fraud_suspected" });

    expect(screen.getByText(/We could not accept this receipt/)).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("fraud_suspected");
    expect(text).not.toMatch(/fraud|signal|score|confidence/i);
  });

  it("ignores an event for a receipt the strip is not showing", () => {
    renderWallet([receipt({ receiptId: "another-receipt", status: "processing" })]);

    emitChange({ status: "approved" });

    expect(screen.getByText(/Processing receipt/)).toBeInTheDocument();
    expect(mocks.fetchReceiptDetail).not.toHaveBeenCalled();
  });
});

describe("watch lifecycle", () => {
  it("does not subscribe when nothing is pending", () => {
    renderWallet([receipt({ status: "approved", pointsAwarded: 245 })]);
    expect(mocks.configs).toHaveLength(0);
  });

  it("does not keep watching a receipt parked in review for up to a day", () => {
    renderWallet([receipt({ status: "processing" })]);
    expect(mocks.configs).toHaveLength(1);

    emitChange({ status: "review" });

    expect(mocks.removeChannel).toHaveBeenCalled();
  });

  it("stops watching once the last pending receipt settles", () => {
    renderWallet([receipt({ status: "processing" })]);

    emitChange({ status: "rejected", reject_reason: "too_old" });

    expect(mocks.removeChannel).toHaveBeenCalled();
  });

  it("keeps watching while another receipt is still pending", () => {
    renderWallet([
      receipt({ receiptId: RECEIPT_ID, status: "processing" }),
      receipt({ receiptId: "second-receipt", status: "queued" }),
    ]);

    emitChange({ status: "review" });

    expect(mocks.removeChannel).not.toHaveBeenCalled();
  });
});

describe("poll fallback", () => {
  it("refreshes the whole strip from GET /api/v1/me/receipts when the socket drops", async () => {
    vi.useFakeTimers();
    mocks.fetchMyReceipts.mockResolvedValue([
      receipt({ status: "approved", pointsAwarded: 245 }),
    ]);

    renderWallet([receipt({ status: "processing" })]);

    act(() => {
      for (const callback of mocks.subscribeCallbacks) callback("CHANNEL_ERROR");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(mocks.fetchMyReceipts).toHaveBeenCalledWith({ limit: WALLET_RECEIPT_LIMIT });
    expect(screen.getByText("+245 pts")).toBeInTheDocument();
  });

  it("leaves the strip untouched when a poll tick fails", async () => {
    vi.useFakeTimers();
    mocks.fetchMyReceipts.mockResolvedValue(null);

    renderWallet([receipt({ status: "processing" })]);

    act(() => {
      for (const callback of mocks.subscribeCallbacks) callback("CHANNEL_ERROR");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByText(/Processing receipt/)).toBeInTheDocument();
  });
});
