import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: nav.refresh }) }));

import { ReviewDecisionScreen } from "./decision-screen";
import type { ReviewActionResult } from "./actions";
import type { FraudSignalView, ReviewDecisionItem } from "./types";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const RECEIPT_ID = "01980000-0000-7000-8000-000000000001";

function signal(overrides: Partial<FraudSignalView> = {}): FraudSignalView {
  return {
    id: "sig-1",
    signal: "velocity",
    severity: "warn",
    score: 0.7,
    evidence: { window: "pair_10min", count: 3, cap: 2 },
    createdAt: "2026-07-25T09:00:01.000Z",
    matchedReceipt: null,
    matchedReceiptOutsideTenant: false,
    ...overrides,
  };
}

function decisionItem(overrides: Partial<ReviewDecisionItem> = {}): ReviewDecisionItem {
  return {
    receiptId: RECEIPT_ID,
    status: "review",
    consumerName: "Karla Reyes",
    submittedByViewer: false,
    createdAt: "2026-07-25T09:00:00.000Z",
    reviewedAt: null,
    rejectReason: null,
    fields: {
      merchantName: "SARI SARI EXPRES",
      receiptNumber: "0012345",
      receiptDate: "2026-07-24T00:00:00.000Z",
      subtotalCentavos: 16_964,
      taxCentavos: 2_036,
      totalCentavos: 19_000,
    },
    lineItems: [
      {
        id: "li-1",
        rawText: "PANDESAL x10",
        qty: 10,
        unitPriceCentavos: 500,
        lineTotalCentavos: 5_000,
        sort: 0,
      },
    ],
    parseMeta: {
      engine: "parse/v1",
      tier: "heuristic",
      templateId: null,
      fields: {
        merchant_name: { tier: "heuristic", present: true },
        receipt_number: { tier: "heuristic", present: true },
        receipt_date: { tier: "heuristic", present: false },
        subtotal_centavos: { tier: "heuristic", present: true },
        tax_centavos: { tier: "heuristic", present: true },
        total_centavos: { tier: "template", present: true },
      },
      vatConsistent: true,
      withinAmountSanity: true,
      dateAmbiguous: false,
      notes: [],
      ocrMeanConfidence: 0.71,
      // Stage 5's merchant-name check passed on this fixture, so the screen
      // renders no banner and every assertion below is unchanged.
      merchantCheck: {
        verdict: "match",
        score: 1,
        threshold: 0.35,
        headerText: "ALING NENA BAKERY",
        matchedAlias: null,
        rival: null,
      },
      reviewReasons: [],
    },
    parseConfidence: 0.82,
    matchConfidence: 0.9,
    signals: [signal()],
    imageUrl: "https://signed.example/receipt.jpg",
    history: {
      receiptsAtBusiness: 6,
      approvedAtBusiness: 5,
      rejectedAtBusiness: 1,
      priorSignalsAtBusiness: 2,
    },
    ...overrides,
  };
}

const OK: ReviewActionResult = { ok: true, status: "approved", pointsAwarded: 190 };

/** The shape the screen calls its two action props with. */
type Handler = (input: unknown) => Promise<ReviewActionResult>;

function handler(result: ReviewActionResult = OK) {
  return vi.fn<Handler>(async () => result);
}

function renderScreen(
  item: ReviewDecisionItem = decisionItem(),
  handlers: { onApprove?: Handler; onReject?: Handler } = {},
) {
  const onApprove = handlers.onApprove ?? handler();
  const onReject = handlers.onReject ?? handler();
  const utils = render(
    <ReviewDecisionScreen
      item={item}
      businessName="Sari Sari Express"
      now={NOW}
      onApprove={onApprove}
      onReject={onReject}
    />,
  );
  return { ...utils, onApprove, onReject };
}

beforeEach(() => {
  nav.refresh.mockReset();
});

// ===========================================================================

describe("the evidence display contract", () => {
  it("puts the receipt image beside the editable fields", () => {
    renderScreen();

    const image = screen.getByAltText("The receipt as the customer photographed it");
    expect(image).toHaveAttribute("src", "https://signed.example/receipt.jpg");
    expect(screen.getByText(/link works for five minutes/)).toBeInTheDocument();
  });

  it("pre-fills every field with the parsed value", () => {
    renderScreen();

    expect(screen.getByLabelText("Merchant")).toHaveValue("SARI SARI EXPRES");
    expect(screen.getByLabelText("Receipt number")).toHaveValue("0012345");
    expect(screen.getByLabelText("Receipt date")).toHaveValue("2026-07-24");
    expect(screen.getByLabelText("Subtotal")).toHaveValue("169.64");
    expect(screen.getByLabelText("Tax")).toHaveValue("20.36");
    expect(screen.getByLabelText("Total")).toHaveValue("190.00");
    expect(screen.getByLabelText("Item 1")).toHaveValue("PANDESAL x10");
  });

  it("carries a per-field source and confidence chip derived from parse_meta", () => {
    renderScreen();

    expect(screen.getAllByText("Read from the image · 82% confident").length).toBeGreaterThan(0);
    expect(screen.getByText("From your template · 82% confident")).toBeInTheDocument();
    // The date was not found, so it says so instead of showing a confidence.
    expect(screen.getByText("Not found")).toBeInTheDocument();
  });

  it("renders the fraud signal list with severity, score and rendered evidence", () => {
    renderScreen();

    expect(screen.getByText("Scan rate")).toBeInTheDocument();
    expect(screen.getByText("Warning")).toBeInTheDocument();
    expect(screen.getByText("score 0.70 x 0.4")).toBeInTheDocument();
    expect(
      screen.getByText("3 scans at this business within 10 minutes, against an allowance of 2."),
    ).toBeInTheDocument();
    // The count-versus-cap bar doc 37 asks for by name.
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "3");
    expect(screen.getByText("3 of 2 allowed")).toBeInTheDocument();
  });

  it("links a matched duplicate that belongs to this business", () => {
    renderScreen(
      decisionItem({
        signals: [
          signal({
            id: "sig-dup",
            signal: "image_hash_dup",
            severity: "block",
            score: 1,
            evidence: { matched_receipt_id: "r2", hamming_distance: 2, cross_consumer: false },
            matchedReceipt: {
              receiptId: "r2",
              merchantName: "SARI SARI EXPRESS",
              receiptNumber: "0012344",
              receiptDate: "2026-07-23T00:00:00.000Z",
              totalCentavos: 19_000,
              status: "approved",
              createdAt: "2026-07-23T00:00:00.000Z",
            },
          }),
        ],
      }),
    );

    expect(screen.getByText(/2 bits away from a receipt already on file/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /SARI SARI EXPRESS/ });
    expect(link).toHaveAttribute("href", "/business/receipts/r2");
  });

  it("says a duplicate lives at another business without showing anything about it", () => {
    renderScreen(
      decisionItem({
        signals: [
          signal({
            id: "sig-dup",
            signal: "image_hash_dup",
            severity: "block",
            score: 1,
            evidence: { hamming_distance: 1 },
            matchedReceiptOutsideTenant: true,
          }),
        ],
      }),
    );

    expect(screen.getByText(/scanned at a different business/)).toBeInTheDocument();
  });

  it("shows the consumer's history at this business, and says that is the scope", () => {
    renderScreen();

    expect(screen.getByText("This customer at Sari Sari Express")).toBeInTheDocument();
    expect(screen.getByText("Flags raised")).toBeInTheDocument();
    expect(screen.getByText(/Counts cover this customer at Sari Sari Express only/)).toBeInTheDocument();
  });

  it("explains an empty signal list rather than showing a blank panel", () => {
    renderScreen(decisionItem({ signals: [] }));
    expect(screen.getByText(/No detector flagged this receipt/)).toBeInTheDocument();
  });
});

// ===========================================================================

describe("approving", () => {
  it("confirms first, showing the total the points will be computed from", async () => {
    const onApprove = handler();
    renderScreen(decisionItem(), { onApprove });

    fireEvent.click(screen.getByRole("button", { name: "Approve and award points" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("₱190.00")).toBeInTheDocument();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("sends the corrected fields to the review service on confirmation", async () => {
    const onApprove = handler();
    renderScreen(decisionItem(), { onApprove });

    fireEvent.change(screen.getByLabelText("Merchant"), {
      target: { value: "SARI SARI EXPRESS" },
    });
    fireEvent.change(screen.getByLabelText("Total"), { target: { value: "195.50" } });
    fireEvent.change(screen.getByLabelText("Receipt date"), { target: { value: "2026-07-24" } });

    fireEvent.click(screen.getByRole("button", { name: "Approve and award points" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, approve" }));

    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove).toHaveBeenCalledWith({
      receiptId: RECEIPT_ID,
      fields: {
        merchant_name: "SARI SARI EXPRESS",
        receipt_number: "0012345",
        receipt_date: "2026-07-24T00:00:00.000Z",
        subtotal_centavos: 16_964,
        tax_centavos: 2_036,
        total_centavos: 19_550,
      },
    });
  });

  it("leaves line items alone unless the reviewer touched them", async () => {
    const onApprove = handler();
    renderScreen(decisionItem(), { onApprove });

    fireEvent.change(screen.getByLabelText("Item 1"), { target: { value: "PANDESAL x12" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve and award points" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, approve" }));

    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    const payload = onApprove.mock.calls[0]?.[0] as { fields: Record<string, unknown> };
    expect(payload.fields.line_items).toEqual([
      {
        raw_text: "PANDESAL x12",
        qty: 10,
        unit_price_centavos: 500,
        line_total_centavos: 5_000,
      },
    ]);
  });

  it("refuses to submit without a total, because points are computed from it", async () => {
    const onApprove = handler();
    renderScreen(decisionItem(), { onApprove });

    fireEvent.change(screen.getByLabelText("Total"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve and award points" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, approve" }));

    expect(await screen.findByText(/Enter the total. Points are computed from it./)).toBeInTheDocument();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("reports the points awarded and refreshes the screen", async () => {
    renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "Approve and award points" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, approve" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Approved. 190 points were awarded.",
    );
    expect(nav.refresh).toHaveBeenCalled();
  });
});

// ===========================================================================

describe("rejecting", () => {
  it("sends the chosen reason and the note", async () => {
    const onReject = handler({ ok: true, status: "rejected", reason: "fraud_suspected" });
    renderScreen(decisionItem(), { onReject });

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Looks fraudulent/ }));
    fireEvent.change(screen.getByLabelText("Note (optional)"), {
      target: { value: "Same photo as yesterday" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject receipt" }));

    await waitFor(() => expect(onReject).toHaveBeenCalledTimes(1));
    expect(onReject).toHaveBeenCalledWith({
      receiptId: RECEIPT_ID,
      reason: "fraud_suspected",
      note: "Same photo as yesterday",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Rejected as Looks fraudulent.");
  });

  it("omits an empty note rather than sending a blank string", async () => {
    const onReject = handler({ ok: true, status: "rejected", reason: "unreadable" });
    renderScreen(decisionItem(), { onReject });

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reject receipt" }));

    await waitFor(() => expect(onReject).toHaveBeenCalledTimes(1));
    expect(onReject).toHaveBeenCalledWith({ receiptId: RECEIPT_ID, reason: "unreadable" });
  });

  it("warns which reasons count toward a scanning block", async () => {
    renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getAllByText(/Counts toward a temporary scanning block/),
    ).toHaveLength(2);
  });
});

// ===========================================================================

describe("the two states that take the actions away", () => {
  it("explains the self-review block instead of offering the actions", () => {
    renderScreen(decisionItem({ submittedByViewer: true }));

    expect(screen.getByText("Someone else has to decide this one")).toBeInTheDocument();
    expect(screen.getByText(/Ask a colleague with owner or manager access/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve and award points" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    // The fields are still readable, just not editable.
    expect(screen.getByLabelText("Merchant")).toBeDisabled();
  });

  it("says a decided receipt was already decided, and does not offer to decide it again", () => {
    renderScreen(
      decisionItem({
        status: "approved",
        reviewedAt: "2026-07-25T10:00:00.000Z",
      }),
    );

    expect(screen.getByText(/This receipt has been approved/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve and award points" }),
    ).not.toBeInTheDocument();
  });

  it("renders RECEIPT_NOT_REVIEWABLE as news, not as an error", async () => {
    const onApprove = handler({
      ok: false,
      code: "RECEIPT_NOT_REVIEWABLE",
      message: "That receipt has already been decided. Refresh the queue.",
      fieldErrors: [],
    });
    renderScreen(decisionItem(), { onApprove });

    fireEvent.click(screen.getByRole("button", { name: "Approve and award points" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, approve" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/already decided by someone else while you had it open/);
    expect(alert).not.toHaveTextContent(/error/i);

    // The actions are gone, so the loser of the race cannot try again.
    expect(
      screen.queryByRole("button", { name: "Approve and award points" }),
    ).not.toBeInTheDocument();

    fireEvent.click(within(alert).getByRole("button", { name: "Refresh" }));
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("shows a service refusal with its field errors", async () => {
    const onApprove = handler({
      ok: false,
      code: "RECEIPT_FIELDS_INVALID",
      message: "Some of the corrected fields are not valid.",
      fieldErrors: ["total_centavos: Required"],
    });
    renderScreen(decisionItem(), { onApprove });

    fireEvent.click(screen.getByRole("button", { name: "Approve and award points" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, approve" }));

    expect(await screen.findByText("Some of the corrected fields are not valid.")).toBeInTheDocument();
    expect(screen.getByText("total_centavos: Required")).toBeInTheDocument();
  });
});

describe("copy hygiene", () => {
  it("uses no em-dash anywhere on the screen", () => {
    const { container } = renderScreen();
    expect(container.textContent).not.toContain("—");
    expect(container.textContent).not.toContain("–");
  });
});
