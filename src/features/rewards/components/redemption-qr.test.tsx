import { render, screen, waitFor } from "@testing-library/react";
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

import {
  RedemptionQr,
  formatCountdown,
  initialPhase,
  nextPhaseForStatus,
  unavailableMessage,
} from "./redemption-qr";
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

// Review fix I2: the screen's phase was seeded once in a useState
// initializer and never re-derived when the CLAIM ITSELF changed underneath
// it - not on a claim.status prop update (router.refresh() after this
// screen's own cancel), not on a Realtime UPDATE payload, not on the poll
// fallback. All three call sites now funnel through this one pure decision
// so they cannot drift on what counts as a terminal transition, mirroring
// why 0050/0051 centralized the ledger reversal itself.
describe("nextPhaseForStatus", () => {
  it('moves to "redeemed" when the observed status is redeemed', () => {
    expect(nextPhaseForStatus("ready", "redeemed")).toBe("redeemed");
  });

  it('moves to "cancelled" when the observed status is cancelled', () => {
    expect(nextPhaseForStatus("ready", "cancelled")).toBe("cancelled");
  });

  it("leaves the phase alone for any other observed status", () => {
    expect(nextPhaseForStatus("minting", "claimed")).toBe("minting");
    expect(nextPhaseForStatus("ready", "expired")).toBe("ready");
  });

  it("is sticky once already redeemed or cancelled - a stale/duplicate event cannot regress it", () => {
    expect(nextPhaseForStatus("redeemed", "claimed")).toBe("redeemed");
    expect(nextPhaseForStatus("cancelled", "claimed")).toBe("cancelled");
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

  // Review fix M2: cancel_claim (0050) permits cancelling ANY status='claimed'
  // row regardless of expires_at (the sweep just hasn't caught up yet), and
  // ClaimList already offers cancel on this same state. The detail screen
  // used to disagree - canCancel excluded phase "unavailable", which
  // initialPhase also returns for a claimed-but-expired row, so the two
  // screens showed different affordances for the identical claim. Fixed by
  // dropping that exclusion (canCancel now depends on claim.status ===
  // "claimed" directly, which already correctly excludes the OTHER two
  // reasons "unavailable" can fire: a genuinely 'expired' or 'cancelled'
  // server status).
  it("shows a cancel affordance for a claimed reward whose expiresAt has already passed (M2)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("should not mint a claimed-but-late reward"));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RedemptionQr claim={baseClaim({ status: "claimed", expiresAt: "2020-01-01T00:00:00.000Z" })} />,
    );

    expect(screen.getByText("This claim cannot be redeemed right now.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Cancel claim" })).toBeInTheDocument();
    // and, being genuinely late, it never attempted to mint a QR code
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  // Review fix I2: router.refresh() after THIS screen's own cancel action
  // re-renders the server component tree and hands RedemptionQr a NEW
  // `claim` prop (status now 'cancelled'), but a client component's
  // internal state survives a soft navigation - phase does not re-derive on
  // its own. Simulated here via rerender() with an updated prop, which is
  // exactly what Next does under the hood.
  it("stops showing the live QR/cancel affordance once the claim prop itself flips to cancelled", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const claimed = baseClaim({ status: "claimed", expiresAt: "2099-01-01T00:00:00.000Z" });
    const { rerender } = render(<RedemptionQr claim={claimed} />);

    expect(await screen.findByRole("button", { name: "Cancel claim" })).toBeInTheDocument();

    rerender(<RedemptionQr claim={{ ...claimed, status: "cancelled" }} />);

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel claim" })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("This claim was cancelled.")).toBeInTheDocument();

    vi.unstubAllGlobals();
  });
});
