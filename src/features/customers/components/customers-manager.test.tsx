import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { CustomersManager } from "./customers-manager";
import * as actions from "../actions";
import type { CustomerListItem } from "../types";

vi.mock("../actions", () => ({
  changeCustomerSegment: vi.fn(),
  updateCustomerNotes: vi.fn(),
}));

function customer(overrides: Partial<CustomerListItem> = {}): CustomerListItem {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    consumerId: "4f2a1111-1111-4111-8111-111111111111",
    reference: "4F2A",
    segment: "regular",
    pointsBalance: 250,
    lifetimePoints: 900,
    lifetimeSpendCentavos: 12500,
    visitCount: 12,
    firstVisitAt: "2026-01-01T00:00:00.000Z",
    lastVisitAt: "2026-07-20T00:00:00.000Z",
    notes: null,
    ...overrides,
  };
}

function renderManager(props: Partial<React.ComponentProps<typeof CustomersManager>> = {}) {
  return render(
    <CustomersManager
      businessName="Kape Diaria"
      customers={[customer()]}
      segment="all"
      sort="last_visit"
      truncated={false}
      canManage
      pageSize={200}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CustomersManager: the list", () => {
  it("renders the real business_customers columns", () => {
    renderManager();

    // Scoped to the table: the segment names also appear as filter pills above
    // it, and this assertion is about the row, not the chrome.
    const row = within(screen.getByRole("table"));
    expect(row.getByText("4F2A")).toBeInTheDocument();
    expect(row.getByText("250")).toBeInTheDocument();
    expect(row.getByText("900")).toBeInTheDocument();
    expect(row.getByText("12")).toBeInTheDocument();
    expect(row.getByText(/125\.00/)).toBeInTheDocument();
    expect(row.getByText("Regular")).toBeInTheDocument();
  });

  it("labels a blacklisted customer as blocked", () => {
    renderManager({ customers: [customer({ segment: "blacklisted" })] });

    expect(within(screen.getByRole("table")).getByText("Blocked")).toBeInTheDocument();
  });

  it("says 'Never' rather than blank for a customer with no recorded visit", () => {
    renderManager({ customers: [customer({ lastVisitAt: null })] });

    expect(screen.getByText("Never")).toBeInTheDocument();
  });

  it("keeps filters and sorts in the url so a view can be bookmarked", () => {
    renderManager();

    expect(screen.getByRole("link", { name: "VIP" })).toHaveAttribute(
      "href",
      "/business/customers?segment=vip&sort=last_visit",
    );
    expect(screen.getByRole("link", { name: "Biggest spend" })).toHaveAttribute(
      "href",
      "/business/customers?segment=all&sort=spend",
    );
  });

  it("marks the active filter for assistive technology, not only visually", () => {
    renderManager({ segment: "vip" });

    expect(screen.getByRole("link", { name: "VIP" })).toHaveAttribute("aria-current", "true");
  });

  it("says when the bounded first page is full", () => {
    renderManager({ truncated: true });

    expect(screen.getByText("Showing the first 200 customers for this view.")).toBeInTheDocument();
  });
});

describe("CustomersManager: the empty state", () => {
  it("explains how customers arrive when there are none at all", () => {
    renderManager({ customers: [] });

    expect(screen.getByText("No customers yet")).toBeInTheDocument();
    expect(screen.getByText(/first time they scan a receipt/i)).toBeInTheDocument();
  });

  it("distinguishes an empty filter from an empty business", () => {
    renderManager({ customers: [], segment: "vip" });

    expect(screen.getByText("Nobody in this group")).toBeInTheDocument();
  });
});

describe("CustomersManager: who may change standing", () => {
  it("offers the Manage action to an owner or manager", () => {
    renderManager({ canManage: true });

    expect(screen.getByRole("button", { name: "Manage" })).toBeInTheDocument();
  });

  it("gives marketing the same list with no way to change standing", () => {
    renderManager({ canManage: false });

    expect(screen.queryByRole("button", { name: "Manage" })).not.toBeInTheDocument();
    expect(screen.getByText("4F2A")).toBeInTheDocument();
  });
});

describe("CustomersManager: the segment flow", () => {
  it("promotes a customer to VIP without asking for a reason", async () => {
    vi.mocked(actions.changeCustomerSegment).mockResolvedValue({ ok: true });
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.click(screen.getByRole("radio", { name: /VIP/ }));

    expect(screen.queryByLabelText("Why are you blocking them?")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save standing" }));

    await waitFor(() =>
      expect(actions.changeCustomerSegment).toHaveBeenCalledWith({
        customerId: customer().id,
        segment: "vip",
      }),
    );
  });

  it("asks for a reason before blocking someone, and sends it", async () => {
    vi.mocked(actions.changeCustomerSegment).mockResolvedValue({ ok: true });
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.click(screen.getByRole("radio", { name: /Blocked/ }));

    const reason = screen.getByLabelText("Why are you blocking them?");
    fireEvent.change(reason, { target: { value: "Repeated fake receipts" } });
    fireEvent.click(screen.getByRole("button", { name: "Save standing" }));

    await waitFor(() =>
      expect(actions.changeCustomerSegment).toHaveBeenCalledWith({
        customerId: customer().id,
        segment: "blacklisted",
        reason: "Repeated fake receipts",
      }),
    );
  });

  it("cannot save a standing that is already the current one", () => {
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));

    expect(screen.getByRole("button", { name: "Save standing" })).toBeDisabled();
  });

  it("shows the server's refusal instead of closing the dialog", async () => {
    vi.mocked(actions.changeCustomerSegment).mockResolvedValue({
      ok: false,
      message: "Say why this customer is being blocked.",
    });
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.click(screen.getByRole("radio", { name: /Blocked/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save standing" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Say why this customer is being blocked.",
    );
  });
});

describe("CustomersManager: notes", () => {
  it("saves a private note and says it is never shown to the customer", async () => {
    vi.mocked(actions.updateCustomerNotes).mockResolvedValue({ ok: true });
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByText(/never shown to the customer/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Private note"), {
      target: { value: "Always orders oat milk" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() =>
      expect(actions.updateCustomerNotes).toHaveBeenCalledWith({
        customerId: customer().id,
        notes: "Always orders oat milk",
      }),
    );
  });

  it("opens the note field prefilled with what is already stored", () => {
    renderManager({ customers: [customer({ notes: "Allergic to peanuts" })] });

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));

    expect(screen.getByLabelText("Private note")).toHaveValue("Allergic to peanuts");
  });
});
