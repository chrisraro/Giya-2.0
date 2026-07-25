import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { ClaimList, formatExpiry } from "./claim-list";
import type { MyClaimDTO } from "../types";

// Fixed "now", deliberately mid-day UTC (noon in Asia/Manila, UTC+8) so
// every fixture below sits comfortably inside its intended Manila calendar
// day regardless of the machine/CI timezone running the test - formatExpiry
// itself computes "today"/"tomorrow" in Asia/Manila (matching the
// convention already used by src/lib/hours.ts's currentManilaWeekday), not
// the test runner's local zone.
const NOW = new Date("2026-07-25T04:00:00.000Z"); // 2026-07-25T12:00 Manila

function baseClaim(overrides: Partial<MyClaimDTO> = {}): MyClaimDTO {
  return {
    claimId: "claim-1",
    rewardId: "reward-1",
    rewardName: "Free latte",
    businessId: "biz-1",
    businessName: "Kape Diaria",
    status: "claimed",
    pointsSpent: 500,
    claimedAt: "2026-07-20T00:00:00.000Z",
    expiresAt: "2026-08-06T04:00:00.000Z", // 12 Manila-calendar-days after NOW
    redeemedAt: null,
    ...overrides,
  };
}

describe("formatExpiry", () => {
  it('renders "Expires in 12 days" twelve days out', () => {
    expect(formatExpiry("2026-08-06T04:00:00.000Z", NOW)).toBe("Expires in 12 days");
  });

  it('renders "Expires today" a few hours before expiry, same Manila calendar day', () => {
    expect(formatExpiry("2026-07-25T10:00:00.000Z", NOW)).toBe("Expires today");
  });

  it('renders "Expires tomorrow" for an expiry on the next Manila calendar day', () => {
    expect(formatExpiry("2026-07-26T02:00:00.000Z", NOW)).toBe("Expires tomorrow");
  });

  it('renders "Expired" once expiresAt has passed', () => {
    expect(formatExpiry("2026-07-25T00:00:00.000Z", NOW)).toBe("Expired");
  });

  it("pluralizes multi-day counts correctly", () => {
    expect(formatExpiry("2026-07-30T04:00:00.000Z", NOW)).toBe("Expires in 5 days");
  });
});

describe("ClaimList", () => {
  it("shows an EmptyState when there are no claims", () => {
    render(<ClaimList claims={[]} now={NOW} />);
    expect(screen.getByText("Nothing claimed yet")).toBeInTheDocument();
  });

  it("shows the expiry text and a Show QR link for a live claimed reward", () => {
    render(<ClaimList claims={[baseClaim()]} now={NOW} />);

    expect(screen.getByText("Free latte")).toBeInTheDocument();
    expect(screen.getByText("Kape Diaria")).toBeInTheDocument();
    expect(screen.getByText("Expires in 12 days")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Show QR" })).toHaveAttribute(
      "href",
      "/rewards/claims/claim-1",
    );
  });

  it("does not show a Show QR link or expiry text for a redeemed claim", () => {
    render(
      <ClaimList
        claims={[baseClaim({ status: "redeemed", redeemedAt: "2026-07-24T00:00:00.000Z" })]}
        now={NOW}
      />,
    );

    expect(screen.queryByRole("link", { name: "Show QR" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Expires/)).not.toBeInTheDocument();
    expect(screen.getByText("Redeemed")).toBeInTheDocument();
  });

  it("does not show a Show QR link for a claimed reward whose expiresAt has already passed", () => {
    render(
      <ClaimList
        claims={[baseClaim({ status: "claimed", expiresAt: "2026-07-01T00:00:00.000Z" })]}
        now={NOW}
      />,
    );

    expect(screen.queryByRole("link", { name: "Show QR" })).not.toBeInTheDocument();
  });

  it("shows status chips for expired and cancelled claims", () => {
    render(
      <ClaimList
        claims={[
          baseClaim({ claimId: "c-2", status: "expired" }),
          baseClaim({ claimId: "c-3", status: "cancelled" }),
        ]}
        now={NOW}
      />,
    );

    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });
});
