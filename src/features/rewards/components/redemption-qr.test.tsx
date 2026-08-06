import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// `@/lib/supabase/client` transitively imports `@/lib/env`, which throws at
// module-evaluation time unless real NEXT_PUBLIC_SUPABASE_* vars are set
// (see src/components/auth/auth.test.tsx for the same workaround). Neither
// smoke test below reaches the Realtime effect (both start in a terminal
// phase where "awaitingRedemption" is false), but the module import itself
// still has to succeed.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel: () => ({
      on: () => ({ subscribe: () => ({}) }),
    }),
    removeChannel: () => {},
  }),
}));

// `../actions` (getClaimStatus, the poll fallback) transitively imports
// `@/lib/supabase/server`, which has the same env-at-import-time issue as
// `@/lib/supabase/client` above. cancelClaim is mocked here too (task 1.4):
// the cancel affordance's own <CancelClaimButton> imports it directly, the
// same convention getClaimStatus already uses in this file.
vi.mock("../actions", () => ({
  getClaimStatus: vi.fn(),
  cancelClaim: vi.fn(),
}));

// <CancelClaimButton> uses next/navigation's router.refresh() on a
// successful cancel; not exercised by the tests in this file (that is
// cancel-claim-button.test.tsx's job), but the module must still resolve.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { RedemptionQr, formatCountdown, initialPhase, unavailableMessage } from "./redemption-qr";
import type { ClaimDetailDTO } from "../types";

// formatCountdown/initialPhase/unavailableMessage are pure and carry the
// real logic; the redemption-qr.tsx module also wires up fetch (mint),
// window online/offline listeners, wakeLock, and a Supabase Realtime
// subscription with a poll fallback, none of which are practical (or that
// valuable) to fully exercise in jsdom - see task-5-report.md. The two
// component smoke tests below cover the two initial phases ("redeemed" /
// "unavailable") that resolve WITHOUT touching fetch or Realtime at all,
// so they need no network/module mocking.

describe("formatCountdown", () => {
  it("formats exactly 5:00 for 300000ms", () => {
    expect(formatCountdown(300_000)).toBe("5:00");
  });

  it('formats "4:59" for 299000ms (one second under 5:00)', () => {
    expect(formatCountdown(299_000)).toBe("4:59");
  });

  it("pads single-digit seconds", () => {
    expect(formatCountdown(61_000)).toBe("1:01");
  });

  it("does not pad minutes", () => {
    expect(formatCountdown(3_600_000)).toBe("60:00");
  });

  it('formats "0:00" at exactly zero', () => {
    expect(formatCountdown(0)).toBe("0:00");
  });

  it('clamps negative remaining time to "0:00"', () => {
    expect(formatCountdown(-5_000)).toBe("0:00");
  });

  it("rounds a sub-second remainder up rather than truncating to 0", () => {
    // 500ms left should still read as 1 second, not "0:00" - a customer
    // should never see the code as already-expired before it truly is.
    expect(formatCountdown(500)).toBe("0:01");
  });
});

describe("initialPhase", () => {
  const LIVE_CLAIM: Pick<ClaimDetailDTO, "status" | "expiresAt"> = {
    status: "claimed",
    expiresAt: "2026-08-01T00:00:00.000Z",
  };
  const NOW = new Date("2026-07-25T00:00:00.000Z");

  it('returns "redeemed" when the claim is already redeemed, regardless of expiry', () => {
    expect(
      initialPhase({ status: "redeemed", expiresAt: "2020-01-01T00:00:00.000Z" }, { isOnline: true, now: NOW }),
    ).toBe("redeemed");
  });

  it('returns "unavailable" for a non-claimed, non-redeemed status (e.g. cancelled)', () => {
    expect(initialPhase({ status: "cancelled", expiresAt: "2026-08-01T00:00:00.000Z" }, { isOnline: true, now: NOW })).toBe(
      "unavailable",
    );
  });

  it('returns "unavailable" for a claimed reward whose expiresAt has already passed', () => {
    expect(
      initialPhase({ status: "claimed", expiresAt: "2020-01-01T00:00:00.000Z" }, { isOnline: true, now: NOW }),
    ).toBe("unavailable");
  });

  it('returns "offline" for a still-live claimed reward when the browser is offline', () => {
    expect(initialPhase(LIVE_CLAIM, { isOnline: false, now: NOW })).toBe("offline");
  });

  it('returns "minting" for a still-live claimed reward when online', () => {
    expect(initialPhase(LIVE_CLAIM, { isOnline: true, now: NOW })).toBe("minting");
  });
});

describe("unavailableMessage", () => {
  it("maps expired", () => {
    expect(unavailableMessage("expired")).toBe("This claim has expired.");
  });

  it("maps cancelled", () => {
    expect(unavailableMessage("cancelled")).toBe("This claim was cancelled.");
  });

  it("falls back to a generic message for anything else", () => {
    expect(unavailableMessage("weird_status")).toBe("This claim cannot be redeemed right now.");
  });
});

function baseClaim(overrides: Partial<ClaimDetailDTO> = {}): ClaimDetailDTO {
  return {
    claimId: "claim-1",
    rewardId: "reward-1",
    rewardName: "Free latte",
    businessId: "biz-1",
    consumerId: "consumer-1",
    businessName: "Kape Diaria",
    status: "claimed",
    pointsSpent: 500,
    claimedAt: "2026-07-20T00:00:00.000Z",
    expiresAt: "2026-08-01T00:00:00.000Z",
    redeemedAt: null,
    ...overrides,
  };
}

describe("RedemptionQr", () => {
  it("renders a redeemed success view immediately when the claim is already redeemed", () => {
    render(<RedemptionQr claim={baseClaim({ status: "redeemed", redeemedAt: "2026-07-24T00:00:00.000Z" })} />);

    expect(screen.getByText("Redeemed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Rewards" })).toHaveAttribute("href", "/rewards");
  });

  it("renders an unavailable view for an expired claim without attempting to mint", () => {
    render(<RedemptionQr claim={baseClaim({ status: "expired" })} />);

    expect(screen.getByText("This claim has expired.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Rewards" })).toHaveAttribute("href", "/rewards");
  });

  it("never shows a cancel affordance once the claim is redeemed", () => {
    render(<RedemptionQr claim={baseClaim({ status: "redeemed", redeemedAt: "2026-07-24T00:00:00.000Z" })} />);

    expect(screen.queryByRole("button", { name: "Cancel claim" })).not.toBeInTheDocument();
  });

  it("never shows a cancel affordance for an expired claim", () => {
    render(<RedemptionQr claim={baseClaim({ status: "expired" })} />);

    expect(screen.queryByRole("button", { name: "Cancel claim" })).not.toBeInTheDocument();
  });

  // Task 1.4: the detail screen offers cancel while the claim is still
  // 'claimed', regardless of the QR-minting phase (minting/ready/offline/
  // code-expired/mint-error all reach here with status='claimed'). Forcing
  // a mint failure (fetch rejects) is the simplest deterministic phase to
  // assert against without mocking the QR token payload itself.
  it("shows a cancel affordance for a still-claimed reward even if the QR mint fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    // expiresAt must be safely in the future relative to the REAL clock:
    // initialPhase (unlike formatExpiry elsewhere in this feature) is
    // computed from `new Date()`, not an injectable `now`, because it runs
    // once in RedemptionQr's own useState initializer.
    render(
      <RedemptionQr claim={baseClaim({ status: "claimed", expiresAt: "2099-01-01T00:00:00.000Z" })} />,
    );

    expect(await screen.findByRole("button", { name: "Cancel claim" })).toBeInTheDocument();

    vi.unstubAllGlobals();
  });
});
