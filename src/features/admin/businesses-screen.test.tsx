import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The decision panel's server actions are stubbed: they exist to be called on a
// click, and importing them for real drags the whole server env into a render
// test. The panel ITSELF is the real one, because half of what these tests
// assert is what it refuses to offer.
vi.mock("./business-actions", () => ({
  approveBusinessAction: vi.fn(),
  sendBusinessBackAction: vi.fn(),
}));

// ===========================================================================
// THE VERIFICATION QUEUE RENDERS REAL APPLICANTS OR AN HONEST ABSENCE.
//
// The same fence ./screens.test.tsx puts around the fraud queues, on the screen
// where the stakes are different: every row here is a merchant who cannot be
// found by a customer, cannot be scanned for, and cannot earn anyone a point.
// An empty list on a failed read tells an operator to close the tab, and the
// merchants stay invisible.
//
// The second thing asserted here has no equivalent on the other queues: the
// approve control must be UNAVAILABLE, with the reason on screen, when the
// merchant has no earning rule. `activate_business` (migration 0033) refuses
// that activation at the database, and an admin should not have to type a
// justification to discover it.
// ===========================================================================

import { AdminBusinessesScreen } from "./businesses-screen";
import type { AdminBusinessReviewItem } from "./types";

const NOW = new Date("2026-07-30T12:00:00.000Z");

function item(overrides: Partial<AdminBusinessReviewItem> = {}): AdminBusinessReviewItem {
  return {
    businessId: "aaaaaaaa-1111-4111-8111-111111111111",
    name: "Kape Bagong Silang",
    slug: "kape-bagong-silang",
    cityName: "Naga",
    businessTypeName: "Cafe",
    contactEmail: "hello@kapebagong.ph",
    contactPhone: null,
    ownerName: "Ramon Dela Cruz",
    createdAt: "2026-07-20T02:00:00.000Z",
    submittedAt: "2026-07-29T02:00:00.000Z",
    applicantNote: "Permits are with the city hall.",
    earningRule: "1 point per ₱100.00 spent",
    hasMenu: true,
    ...overrides,
  };
}

describe("AdminBusinessesScreen", () => {
  it("renders the facts a decision needs", () => {
    render(<AdminBusinessesScreen items={[item()]} now={NOW} canAct={true} />);

    expect(screen.getByText("Kape Bagong Silang")).toBeInTheDocument();
    expect(screen.getByText(/Cafe · Naga/)).toBeInTheDocument();
    expect(screen.getByText("Ramon Dela Cruz")).toBeInTheDocument();
    expect(screen.getByText("hello@kapebagong.ph")).toBeInTheDocument();
    expect(screen.getByText("1 point per ₱100.00 spent")).toBeInTheDocument();
    expect(screen.getByText("Has items")).toBeInTheDocument();
    expect(screen.getByText("Permits are with the city hall.")).toBeInTheDocument();
  });

  it("ages the wait from the submission, not from registration", () => {
    // Registered 2026-07-20, applied 2026-07-29, "now" is 2026-07-30. They have
    // been waiting one day, not ten.
    render(<AdminBusinessesScreen items={[item()]} now={NOW} canAct={true} />);
    expect(screen.getByText("Waiting 1 day")).toBeInTheDocument();
  });

  it("allows approving business signups even when there is no pre-configured earning rule", () => {
    render(
      <AdminBusinessesScreen items={[item({ earningRule: null })]} now={NOW} canAct={true} />,
    );

    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("still allows sending back a business with no earning rule, which is the way out", () => {
    render(
      <AdminBusinessesScreen items={[item({ earningRule: null })]} now={NOW} canAct={true} />,
    );
    expect(screen.getByRole("button", { name: "Send back" })).toBeEnabled();
  });

  it("disables every control for a read-only support account and says so", () => {
    render(<AdminBusinessesScreen items={[item()]} now={NOW} canAct={false} />);

    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send back" })).toBeDisabled();
    expect(screen.getByText(/read-only/)).toBeInTheDocument();
  });

  it("explains what an empty queue means rather than showing a bare zero", () => {
    render(<AdminBusinessesScreen items={[]} now={NOW} canAct={true} />);

    expect(screen.getByText("No business is waiting on a decision")).toBeInTheDocument();
    expect(screen.getByText(/nobody has asked, not that nobody has signed up/)).toBeInTheDocument();
  });

  it("CRITICAL: suppresses the empty state entirely when the read failed", () => {
    render(<AdminBusinessesScreen items={[]} now={NOW} canAct={true} unavailable />);

    expect(screen.getByRole("alert")).toHaveTextContent(/cannot be loaded right now/);
    expect(screen.queryByText("No business is waiting on a decision")).not.toBeInTheDocument();
  });

  it("carries no invented figure anywhere on an empty queue", () => {
    const { container } = render(<AdminBusinessesScreen items={[]} now={NOW} canAct={true} />);
    expect(container.textContent ?? "").not.toMatch(/\d+\s*(businesses|merchants)/i);
  });
});
