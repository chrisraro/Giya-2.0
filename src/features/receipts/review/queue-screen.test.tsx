import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReviewQueueScreen } from "./queue-screen";
import type { ReviewQueueItem, ReviewQueueStatus } from "./types";

const NOW = new Date("2026-07-25T12:00:00.000Z");

function item(overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    receiptId: "r1",
    consumerName: "Karla Reyes",
    merchantName: "SARI SARI EXPRESS",
    receiptNumber: "0012345",
    totalCentavos: 19_000,
    createdAt: "2026-07-25T09:00:00.000Z",
    receiptDate: "2026-07-24T00:00:00.000Z",
    status: "review",
    reviewedAt: null,
    rejectReason: null,
    topSeverity: "warn",
    signalCount: 2,
    fraudScore: 0.62,
    submittedByViewer: false,
    ...overrides,
  };
}

function renderQueue(
  status: ReviewQueueStatus,
  items: ReviewQueueItem[],
  extra: { pendingCount?: number | null; unavailable?: boolean } = {},
) {
  return render(
    <ReviewQueueScreen
      businessName="Sari Sari Express"
      status={status}
      items={items}
      pendingCount={extra.pendingCount === undefined ? items.length : extra.pendingCount}
      now={NOW}
      {...(extra.unavailable === undefined ? {} : { unavailable: extra.unavailable })}
    />,
  );
}

describe("ReviewQueueScreen", () => {
  it("renders a queue row with the consumer, the merchant, the total and the queue age", () => {
    renderQueue("review", [item()]);

    const row = screen.getByRole("link", { name: /SARI SARI EXPRESS/ });
    expect(row).toHaveAttribute("href", "/business/receipts/r1");
    expect(within(row).getByText(/Karla Reyes/)).toBeInTheDocument();
    expect(within(row).getByText("₱190.00")).toBeInTheDocument();
    expect(within(row).getByText("Waiting 3 hours")).toBeInTheDocument();
  });

  it("shows the fraud severity at a glance", () => {
    renderQueue("review", [item({ topSeverity: "block", signalCount: 3 })]);
    expect(screen.getByText("Blocking · 3")).toBeInTheDocument();
  });

  it("warns on the item the viewer submitted themselves, before they open it", () => {
    renderQueue("review", [item({ submittedByViewer: true })]);
    expect(screen.getByText("You submitted this")).toBeInTheDocument();
  });

  it("marks the active tab and links the other two filters", () => {
    renderQueue("review", [item()]);

    const active = screen.getByRole("link", { name: "Needs review" });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Approved" })).toHaveAttribute(
      "href",
      "/business/receipts?status=approved",
    );
    expect(screen.getByRole("link", { name: "Rejected" })).toHaveAttribute(
      "href",
      "/business/receipts?status=rejected",
    );
    expect(screen.getByRole("link", { name: "Rejected" })).not.toHaveAttribute("aria-current");
  });

  it("shows the reject reason instead of a queue age on the rejected tab", () => {
    renderQueue("rejected", [
      item({
        status: "rejected",
        rejectReason: "duplicate",
        reviewedAt: "2026-07-25T10:00:00.000Z",
      }),
    ]);

    expect(screen.getByText("Already scanned")).toBeInTheDocument();
    expect(screen.queryByText(/Waiting/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rejected" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("reads well when there is nothing to review, which is the normal state", () => {
    renderQueue("review", [], { pendingCount: 0 });

    expect(screen.getByText("Nothing waiting on you")).toBeInTheDocument();
    expect(screen.getByText(/every scan went through on its own/)).toBeInTheDocument();
    expect(screen.getByText("Nothing waiting")).toBeInTheDocument();
  });

  it("uses different empty copy for the history tabs", () => {
    renderQueue("approved", []);
    expect(screen.getByText("No approvals yet")).toBeInTheDocument();
  });

  it("says the queue could not be loaded rather than claiming it is empty", () => {
    renderQueue("review", [], { unavailable: true });

    expect(screen.getByRole("alert")).toHaveTextContent(/cannot be loaded right now/);
    expect(screen.queryByText("Nothing waiting on you")).not.toBeInTheDocument();
  });

  // The failed-read case as the page actually assembles it: `listReviewQueue`
  // answered null, so there are no items AND no count, and neither the empty
  // state nor the summary number may claim the queue is clear.
  it("renders the unavailable state, not the empty state, when the read failed", () => {
    renderQueue("review", [], { unavailable: true, pendingCount: null });

    expect(screen.getByRole("alert")).toHaveTextContent(/cannot be loaded right now/);
    expect(screen.queryByText("Nothing waiting on you")).not.toBeInTheDocument();
    expect(screen.queryByText(/every scan went through on its own/)).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing waiting")).not.toBeInTheDocument();
  });

  // A count that failed while the list loaded: the rows are real and stay, but
  // the summary says nothing rather than saying zero.
  it("shows no waiting count at all when the count could not be read", () => {
    renderQueue("review", [item()], { pendingCount: null });

    expect(screen.queryByText("Nothing waiting")).not.toBeInTheDocument();
    expect(screen.queryByText(/waiting or more/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /SARI SARI EXPRESS/ })).toBeInTheDocument();
  });

  it("caps the waiting count so a runaway backlog still reads", () => {
    renderQueue("review", [item()], { pendingCount: 100 });
    expect(screen.getByText("100 waiting or more")).toBeInTheDocument();
  });

  it("uses no em-dash anywhere in its copy", () => {
    const { container } = renderQueue("review", [item()]);
    expect(container.textContent).not.toContain("—");
    expect(container.textContent).not.toContain("–");
  });
});
