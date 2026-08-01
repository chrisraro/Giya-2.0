import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ReceiptListItemDTO, ReceiptStatus } from "../types";
import {
  ReceiptHistoryList,
  ReceiptHistoryRow,
  RECEIPT_FILTERS,
  receiptTitle,
} from "./receipt-history-list";

// The /receipts scan history list. A pure server component, so these are
// plain render assertions with no mocking at all: the absence of any
// "use client" boundary here is itself part of the design (doc 33's
// "RSC-first, islands only") and the fact that this file needs no Supabase
// mock is the proof.

const RECEIPT_ID = "11111111-1111-4111-8111-111111111111";

function receipt(overrides: Partial<ReceiptListItemDTO> = {}): ReceiptListItemDTO {
  return {
    receiptId: RECEIPT_ID,
    businessId: "22222222-2222-4222-8222-222222222222",
    businessName: "Kape Diaria",
    status: "approved",
    rejectReason: null,
    merchantName: "KAPE DIARIA",
    receiptNumber: "OR-000412",
    receiptDate: "2026-07-24T04:00:00.000Z",
    totalCentavos: 24500,
    createdAt: "2026-07-25T03:15:00.000Z",
    processedAt: "2026-07-25T03:15:40.000Z",
    pointsAwarded: 245,
    escalatedAt: null,
    ...overrides,
  };
}

describe("receiptTitle", () => {
  it("prefers the matched business over the OCR'd merchant line", () => {
    expect(receiptTitle(receipt({ businessName: "Kape Diaria", merchantName: "KAPE DlARlA" }))).toBe(
      "Kape Diaria",
    );
  });

  it("falls back to the merchant line before the business is matched", () => {
    expect(receiptTitle(receipt({ businessName: null, merchantName: "ALING NENA'S" }))).toBe(
      "ALING NENA'S",
    );
  });

  it("never leaves a row nameless", () => {
    expect(receiptTitle(receipt({ businessName: null, merchantName: null }))).toBe("Receipt");
  });
});

describe("status filter chips", () => {
  it("offers All plus one chip per surfaced state", () => {
    expect(RECEIPT_FILTERS.map((filter) => filter.label)).toEqual([
      "All",
      "Processing",
      "In review",
      "Approved",
      "Not accepted",
    ]);
  });

  it("renders each chip as a link that puts the filter in the URL", () => {
    render(<ReceiptHistoryList receipts={[receipt()]} activeStatus={null} />);

    expect(screen.getByRole("link", { name: "All" })).toHaveAttribute("href", "/receipts");
    expect(screen.getByRole("link", { name: "Approved" })).toHaveAttribute(
      "href",
      "/receipts?status=approved",
    );
    expect(screen.getByRole("link", { name: "Not accepted" })).toHaveAttribute(
      "href",
      "/receipts?status=rejected",
    );
  });

  it("marks the active chip for assistive technology", () => {
    render(<ReceiptHistoryList receipts={[receipt()]} activeStatus="approved" />);

    expect(screen.getByRole("link", { name: "Approved" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "All" })).not.toHaveAttribute("aria-current");
  });

  it("labels the filter row so it is navigable", () => {
    render(<ReceiptHistoryList receipts={[receipt()]} activeStatus={null} />);
    expect(screen.getByRole("navigation", { name: /filter receipts/i })).toBeInTheDocument();
  });
});

describe("empty states", () => {
  it("invites a first scan when the consumer has no receipts at all", () => {
    render(<ReceiptHistoryList receipts={[]} activeStatus={null} />);

    expect(screen.getByText("No receipts yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Scan your first receipt" })).toHaveAttribute(
      "href",
      "/scan",
    );
  });

  it("does not tell a consumer with receipts to scan their first one just because a filter is empty", () => {
    render(<ReceiptHistoryList receipts={[]} activeStatus="review" />);

    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Scan your first receipt" })).not.toBeInTheDocument();
  });
});

describe("rows", () => {
  it("links each row to its status screen", () => {
    render(<ReceiptHistoryRow receipt={receipt()} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", `/scan/${RECEIPT_ID}`);
  });

  it("shows the awarded points as a reward badge once the ledger has them", () => {
    render(<ReceiptHistoryRow receipt={receipt({ status: "approved", pointsAwarded: 245 })} />);
    expect(screen.getByText("+245 pts")).toBeInTheDocument();
  });

  it("CRITICAL: shows no points amount at all for a receipt still being processed", () => {
    render(
      <ReceiptHistoryRow
        receipt={receipt({ status: "processing", pointsAwarded: null, totalCentavos: null })}
      />,
    );

    expect(screen.getByText(/Processing receipt/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/pts\b/);
    expect(document.body.textContent).not.toMatch(/\+\s*\d/);
  });

  it("shows the parsed total, not a points guess, once a pending receipt has one", () => {
    render(
      <ReceiptHistoryRow
        receipt={receipt({ status: "review", pointsAwarded: null, totalCentavos: 24500 })}
      />,
    );

    expect(screen.getByText("₱245.00")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/pts\b/);
  });

  it.each<[ReceiptStatus, string]>([
    ["queued", "Processing receipt"],
    ["processing", "Processing receipt"],
    ["review", "Being reviewed by the store"],
    ["approved", "Points added"],
  ])("labels a %s receipt", (status, label) => {
    const { container } = render(
      <ReceiptHistoryRow receipt={receipt({ status, pointsAwarded: null })} />,
    );
    expect(within(container).getByText(new RegExp(label))).toBeInTheDocument();
  });

  it("labels a rejection with its consumer-safe reason, never the enum value", () => {
    render(
      <ReceiptHistoryRow
        receipt={receipt({ status: "rejected", rejectReason: "fraud_suspected", pointsAwarded: null })}
      />,
    );

    expect(screen.getByText(/We could not accept this receipt/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("fraud_suspected");
  });

  it("renders the submission time in Asia/Manila", () => {
    render(<ReceiptHistoryRow receipt={receipt({ createdAt: "2026-07-25T03:15:00.000Z" })} />);
    // 03:15 UTC is 11:15 in Manila (UTC+8).
    expect(screen.getByText(/Jul 25, 11:15 AM/)).toBeInTheDocument();
  });
});

describe("no fraud detail or reviewer note can reach the DOM", () => {
  it("renders nothing from a fixture polluted with the columns 0017 withholds", () => {
    const polluted = {
      ...receipt({ status: "rejected", rejectReason: "fraud_suspected", pointsAwarded: null }),
      ...({
        reject_note: "matched receipt 8f21 from Ana Cruz",
        parse_meta: { total: { tier: "llm", conf: 0.41 } },
        match_confidence: 0.62,
        sha256: "9f86d081884c7d659a2feaa0c55ad015a",
      } as Record<string, unknown>),
    } as ReceiptListItemDTO;

    render(<ReceiptHistoryList receipts={[polluted]} activeStatus={null} />);

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Ana Cruz");
    expect(text).not.toContain("8f21");
    expect(text).not.toContain("9f86d081");
    expect(text).not.toMatch(/0\.\d\d/);
    expect(text).not.toMatch(/fraud|confidence|signal|severity/i);
  });
});
