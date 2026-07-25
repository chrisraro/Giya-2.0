import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReceiptListItemDTO, ReceiptRejectReason, ReceiptStatus } from "../types";

// The /scan/[receiptId] status screen. Covers all four outcomes, every value
// of the reject_reason enum, and the Realtime-driven transitions including
// the approved-flip that has to go and fetch the awarded points because a
// receipts payload does not carry them.

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

const { ReceiptStatus, applyReceiptChange, statusCopy } = await import("./receipt-status");

const RECEIPT_ID = "11111111-1111-4111-8111-111111111111";

function baseReceipt(overrides: Partial<ReceiptListItemDTO> = {}): ReceiptListItemDTO {
  return {
    receiptId: RECEIPT_ID,
    businessId: "22222222-2222-4222-8222-222222222222",
    businessName: "Kape Diaria",
    status: "processing",
    rejectReason: null,
    merchantName: "KAPE DIARIA",
    receiptNumber: "OR-000412",
    receiptDate: "2026-07-24T04:00:00.000Z",
    totalCentavos: 24500,
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

describe("applyReceiptChange", () => {
  it("applies a status present in the payload", () => {
    const next = applyReceiptChange(baseReceipt(), { status: "review" });
    expect(next.status).toBe("review");
  });

  it("ignores an unknown status rather than corrupting the view", () => {
    const next = applyReceiptChange(baseReceipt({ status: "processing" }), {
      status: "teleported",
    });
    expect(next.status).toBe("processing");
  });

  it("treats an absent field as not-sent, never as cleared", () => {
    // WALRUS strips columns the role cannot select, so a partial payload is
    // normal and must not blank out state the screen already has.
    const current = baseReceipt({ status: "rejected", rejectReason: "duplicate" });
    const next = applyReceiptChange(current, { status: "rejected" });
    expect(next.rejectReason).toBe("duplicate");
  });

  it("applies an explicit null reject_reason", () => {
    const current = baseReceipt({ status: "rejected", rejectReason: "duplicate" });
    const next = applyReceiptChange(current, { status: "review", reject_reason: null });
    expect(next.rejectReason).toBeNull();
  });

  it("maps an unrecognised reject_reason to manual so the screen is never blank", () => {
    const next = applyReceiptChange(baseReceipt(), {
      status: "rejected",
      reject_reason: "brand_new_reason",
    });
    expect(next.rejectReason).toBe("manual");
  });

  it("never takes a points figure from a receipts payload", () => {
    const next = applyReceiptChange(baseReceipt(), {
      status: "approved",
      // A hostile or confused payload field. Points live in the ledger.
      ...({ points: 9999 } as Record<string, unknown>),
    });
    expect(next.pointsAwarded).toBeNull();
  });

  it("clears a stale points figure when a receipt leaves approved", () => {
    const current = baseReceipt({ status: "approved", pointsAwarded: 120 });
    const next = applyReceiptChange(current, { status: "review" });
    expect(next.pointsAwarded).toBeNull();
  });

  it("keeps the points figure while the receipt stays approved", () => {
    const current = baseReceipt({ status: "approved", pointsAwarded: 120 });
    const next = applyReceiptChange(current, { status: "approved", processed_at: "2026-07-25T03:16:00.000Z" });
    expect(next.pointsAwarded).toBe(120);
    expect(next.processedAt).toBe("2026-07-25T03:16:00.000Z");
  });
});

describe("statusCopy", () => {
  it.each<[ReceiptStatus, string]>([
    ["queued", "Receipt received"],
    ["processing", "Reading your receipt"],
    ["review", "The store is checking this"],
  ])("maps %s to its copy", (status, title) => {
    expect(statusCopy(baseReceipt({ status })).title).toBe(title);
  });

  it("maps approved with points to the award copy", () => {
    expect(statusCopy(baseReceipt({ status: "approved", pointsAwarded: 120 })).title).toBe(
      "Points added",
    );
  });

  it.each<[ReceiptRejectReason, string]>([
    ["duplicate", "Already scanned"],
    ["unreadable", "We could not read this photo"],
    ["wrong_business", "This looks like a different store"],
    ["too_old", "Past the scanning window"],
    ["fraud_suspected", "We could not accept this receipt"],
    ["manual", "We could not accept this receipt"],
  ])("maps a %s rejection to its copy", (rejectReason, title) => {
    expect(statusCopy(baseReceipt({ status: "rejected", rejectReason })).title).toBe(title);
  });
});

describe("ReceiptStatus - the four outcomes", () => {
  it("renders the calm pending state while processing, with no progress promise", () => {
    render(<ReceiptStatus receipt={baseReceipt({ status: "processing" })} />);

    expect(screen.getByRole("heading", { name: "Reading your receipt" })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d+\s*%/);
  });

  it("renders the queued acknowledgement", () => {
    render(<ReceiptStatus receipt={baseReceipt({ status: "queued" })} />);
    expect(screen.getByRole("heading", { name: "Receipt received" })).toBeInTheDocument();
  });

  it("renders the award with the points and a wallet CTA", () => {
    render(<ReceiptStatus receipt={baseReceipt({ status: "approved", pointsAwarded: 120 })} />);

    expect(screen.getByRole("heading", { name: "Points added" })).toBeInTheDocument();
    expect(screen.getByText("+120 pts")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to wallet" })).toHaveAttribute("href", "/wallet");
  });

  it("shows no points figure at all when approved but the ledger row has not been read yet", () => {
    render(<ReceiptStatus receipt={baseReceipt({ status: "approved", pointsAwarded: null })} />);

    expect(screen.getByRole("heading", { name: "Receipt approved" })).toBeInTheDocument();
    // `/pts/` alone would match the word "receipts", so match the badge shape.
    expect(screen.queryByText(/^\+[\d,]+ pts$/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\+\s*\d/);
  });

  it("renders the review state as routine, not as an error", () => {
    render(<ReceiptStatus receipt={baseReceipt({ status: "review" })} />);

    expect(screen.getByRole("heading", { name: "The store is checking this" })).toBeInTheDocument();
    expect(screen.getByText(/within a day/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each<[ReceiptRejectReason, string]>([
    ["duplicate", "Already scanned"],
    ["unreadable", "We could not read this photo"],
    ["wrong_business", "This looks like a different store"],
    ["too_old", "Past the scanning window"],
    ["fraud_suspected", "We could not accept this receipt"],
    ["manual", "We could not accept this receipt"],
  ])("renders the %s rejection copy", (rejectReason, title) => {
    render(<ReceiptStatus receipt={baseReceipt({ status: "rejected", rejectReason })} />);
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
  });

  it("offers a retake for an unreadable photo", () => {
    render(<ReceiptStatus receipt={baseReceipt({ status: "rejected", rejectReason: "unreadable" })} />);
    expect(screen.getByRole("link", { name: "Take another photo" })).toHaveAttribute("href", "/scan");
  });

  it("explains a duplicate and links to the history rather than a rescan", () => {
    render(<ReceiptStatus receipt={baseReceipt({ status: "rejected", rejectReason: "duplicate" })} />);

    expect(screen.getByText(/already on your account/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See my receipts" })).toHaveAttribute(
      "href",
      "/receipts",
    );
  });

  it("CRITICAL: offers no rescan path on a fraud_suspected rejection", () => {
    render(
      <ReceiptStatus receipt={baseReceipt({ status: "rejected", rejectReason: "fraud_suspected" })} />,
    );

    const scanLinks = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href") === "/scan");
    expect(scanLinks).toHaveLength(0);
  });

  it("announces the outcome politely for assistive technology", () => {
    const { container } = render(
      <ReceiptStatus receipt={baseReceipt({ status: "approved", pointsAwarded: 120 })} />,
    );

    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain("Points added");
  });
});

describe("ReceiptStatus - Realtime transitions", () => {
  it("subscribes filtered to this receipt row only", () => {
    render(<ReceiptStatus receipt={baseReceipt({ status: "processing" })} />);

    expect(mocks.configs[0]).toMatchObject({
      table: "receipts",
      filter: `id=eq.${RECEIPT_ID}`,
    });
  });

  it("flips from processing to review when the event arrives", () => {
    render(<ReceiptStatus receipt={baseReceipt({ status: "processing" })} />);

    emitChange({ status: "review" });

    expect(screen.getByRole("heading", { name: "The store is checking this" })).toBeInTheDocument();
  });

  it("flips to a rejection and shows that reason's copy", () => {
    render(<ReceiptStatus receipt={baseReceipt({ status: "processing" })} />);

    emitChange({ status: "rejected", reject_reason: "too_old" });

    expect(screen.getByRole("heading", { name: "Past the scanning window" })).toBeInTheDocument();
  });

  it("flips to approved and fetches the awarded points from the ledger-backed endpoint", async () => {
    mocks.fetchReceiptDetail.mockResolvedValue(
      baseReceipt({ status: "approved", pointsAwarded: 245 }),
    );

    render(<ReceiptStatus receipt={baseReceipt({ status: "processing" })} />);
    emitChange({ status: "approved" });

    // Celebrates immediately, without inventing a number.
    expect(screen.getByRole("heading", { name: "Receipt approved" })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("+245 pts")).toBeInTheDocument());
    expect(mocks.fetchReceiptDetail).toHaveBeenCalledWith(RECEIPT_ID);
  });

  it("does not subscribe at all for a receipt that already settled before first paint", () => {
    render(<ReceiptStatus receipt={baseReceipt({ status: "approved", pointsAwarded: 120 })} />);
    expect(mocks.configs).toHaveLength(0);
  });

  it("stops watching once the receipt settles", () => {
    render(<ReceiptStatus receipt={baseReceipt({ status: "processing" })} />);
    expect(mocks.configs).toHaveLength(1);

    emitChange({ status: "rejected", reject_reason: "duplicate" });

    expect(mocks.removeChannel).toHaveBeenCalled();
  });

  it("keeps watching a receipt that lands in review, since a human can still decide", () => {
    render(<ReceiptStatus receipt={baseReceipt({ status: "processing" })} />);

    emitChange({ status: "review" });

    expect(mocks.removeChannel).not.toHaveBeenCalled();
  });

  it("adopts the polled state when the poll fallback fires", async () => {
    vi.useFakeTimers();
    mocks.fetchReceiptDetail.mockResolvedValue(
      baseReceipt({ status: "rejected", rejectReason: "unreadable" }),
    );

    render(<ReceiptStatus receipt={baseReceipt({ status: "processing" })} />);

    act(() => {
      for (const callback of mocks.subscribeCallbacks) callback("CHANNEL_ERROR");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByRole("heading", { name: "We could not read this photo" })).toBeInTheDocument();
  });
});

describe("no fraud detail or reviewer note can reach the DOM", () => {
  it("has no field on the DTO that could carry one, so a polluted fixture leaks nothing", () => {
    // A fixture deliberately spread with the columns 0017 withholds. The DTO
    // has no home for any of them, so nothing reaches the component - and if
    // someone ever adds one, this render starts printing it and fails.
    const polluted = {
      ...baseReceipt({ status: "rejected", rejectReason: "fraud_suspected" }),
      ...({
        reject_note: "same image as receipt 8f21 submitted by Ana Cruz",
        rejectNote: "same image as receipt 8f21 submitted by Ana Cruz",
        parse_meta: { total: { tier: "llm", conf: 0.41 } },
        match_confidence: 0.62,
        parse_confidence: 0.44,
        sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        image_hash: "c0ffee1234567890",
        fraud_signals: [{ signal: "image_hash_dup", score: 0.9, severity: "block" }],
      } as Record<string, unknown>),
    } as ReceiptListItemDTO;

    render(<ReceiptStatus receipt={polluted} />);

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Ana Cruz");
    expect(text).not.toContain("8f21");
    expect(text).not.toContain("image_hash_dup");
    expect(text).not.toContain("9f86d081");
    expect(text).not.toContain("c0ffee");
    expect(text).not.toMatch(/0\.\d\d/);
    expect(text).not.toMatch(/fraud|signal|confidence|severity|block/i);
  });

  it("never renders the raw reject_reason enum value to the consumer", () => {
    render(
      <ReceiptStatus receipt={baseReceipt({ status: "rejected", rejectReason: "fraud_suspected" })} />,
    );

    expect(document.body.textContent).not.toContain("fraud_suspected");
  });
});
