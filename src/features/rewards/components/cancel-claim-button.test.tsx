import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: nav.refresh }) }));

const mocks = vi.hoisted(() => ({ cancelClaim: vi.fn() }));
vi.mock("../actions", () => ({ cancelClaim: mocks.cancelClaim }));

import { CancelClaimButton } from "./cancel-claim-button";

const CLAIM_ID = "22222222-2222-4222-8222-222222222222";

// Task 1.4: the consumer-facing cancel affordance. Two-step (trigger button
// then a Dialog confirm) so a mis-tap never fires the cancel_claim RPC
// directly - mirrors src/features/receipts/review/decision-screen.tsx's
// confirm idiom. Copy states the points return immediately (doc 03 Key
// Finding 1: "points debited on intent and never returned" is the complaint
// this whole task answers), and the confirm step calls the action with the
// claim id ONLY - nothing else about the claim (reward name, business, etc.)
// crosses the client/server boundary as a mutable input.

describe("CancelClaimButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a trigger button, not the confirm dialog, before any tap", () => {
    render(<CancelClaimButton claimId={CLAIM_ID} pointsSpent={500} />);

    expect(screen.getByRole("button", { name: "Cancel claim" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.cancelClaim).not.toHaveBeenCalled();
  });

  it("opens a confirm dialog naming the points on tap, without calling the action yet", () => {
    render(<CancelClaimButton claimId={CLAIM_ID} pointsSpent={500} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel claim" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/Cancel this claim and get your 500 points back/)).toBeInTheDocument();
    expect(mocks.cancelClaim).not.toHaveBeenCalled();
  });

  it("uses non-punitive copy with no points mention for a zero-cost claim", () => {
    render(<CancelClaimButton claimId={CLAIM_ID} pointsSpent={0} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel claim" }));

    expect(screen.queryByText(/points back/)).not.toBeInTheDocument();
  });

  it("confirming calls the action with the claim id only, then closes and refreshes", async () => {
    mocks.cancelClaim.mockResolvedValue({ ok: true, data: { claimId: CLAIM_ID } });

    render(<CancelClaimButton claimId={CLAIM_ID} pointsSpent={500} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel claim" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel" }));

    await waitFor(() => expect(mocks.cancelClaim).toHaveBeenCalledWith({ claimId: CLAIM_ID }));
    expect(mocks.cancelClaim).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("dismissing the dialog never calls the action", () => {
    render(<CancelClaimButton claimId={CLAIM_ID} pointsSpent={500} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel claim" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep claim" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.cancelClaim).not.toHaveBeenCalled();
  });

  it("shows the mapped error and keeps the dialog open when the action fails", async () => {
    mocks.cancelClaim.mockResolvedValue({
      ok: false,
      message: "This claim was already cancelled.",
      code: "CLAIM_ALREADY_CANCELLED",
    });

    render(<CancelClaimButton claimId={CLAIM_ID} pointsSpent={500} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel claim" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel" }));

    await waitFor(() =>
      expect(screen.getByText("This claim was already cancelled.")).toBeInTheDocument(),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});
