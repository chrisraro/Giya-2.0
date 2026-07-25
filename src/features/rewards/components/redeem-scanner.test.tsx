import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// @zxing/browser drives a real <video> element and getUserMedia, neither of
// which exist in jsdom. Mocked to a tiny fake reader whose
// decodeFromConstraints resolves/rejects (and, via `emitDecode` below,
// synthesizes a decode callback) exactly as the tests below need - see
// "RedeemScanner" describe block. The pure helpers and presentational cards
// (the bulk of this file's tests) never touch this mock at all.
const decodeFromConstraintsMock = vi.fn();
vi.mock("@zxing/browser", () => ({
  BrowserQRCodeReader: vi.fn().mockImplementation(function FakeBrowserQRCodeReader() {
    return { decodeFromConstraints: decodeFromConstraintsMock };
  }),
}));

import {
  RedeemScanner,
  RedeemSuccessCard,
  RedeemErrorCard,
  shouldSubmitDecode,
  formatRedeemedAt,
  mapCameraErrorMessage,
} from "./redeem-scanner";

describe("shouldSubmitDecode", () => {
  it("allows a fresh token when nothing is in flight", () => {
    expect(shouldSubmitDecode("token-1", { inFlight: false, lastToken: null })).toBe(true);
  });

  it("rejects an empty token", () => {
    expect(shouldSubmitDecode("", { inFlight: false, lastToken: null })).toBe(false);
  });

  it("rejects any decode while a request is already in flight", () => {
    expect(shouldSubmitDecode("token-1", { inFlight: true, lastToken: null })).toBe(false);
  });

  it("rejects a repeat decode of the very last submitted token, even once idle", () => {
    // A QR in frame decodes many times per second; once a token has been
    // submitted, seeing it again (e.g. the customer's phone still in frame
    // right after the result renders) must not trigger a second submit -
    // that would burn the single-use token and surface a confusing
    // CLAIM_ALREADY_REDEEMED instead of the real result.
    expect(shouldSubmitDecode("token-1", { inFlight: false, lastToken: "token-1" })).toBe(false);
  });

  it("allows a different token even if a previous one was just submitted", () => {
    expect(shouldSubmitDecode("token-2", { inFlight: false, lastToken: "token-1" })).toBe(true);
  });
});

describe("formatRedeemedAt", () => {
  it("formats an ISO timestamp in Asia/Manila time", () => {
    expect(formatRedeemedAt("2026-07-25T05:30:00.000Z")).toBe("Jul 25, 1:30 PM");
  });

  it("pads single-digit minutes and keeps the AM/PM marker", () => {
    expect(formatRedeemedAt("2026-07-25T00:05:00.000Z")).toBe("Jul 25, 8:05 AM");
  });
});

describe("mapCameraErrorMessage", () => {
  it("maps a not-found device to a device-specific message", () => {
    const error = new Error("no camera");
    error.name = "NotFoundError";
    expect(mapCameraErrorMessage(error)).toBe("No camera was found on this device.");
  });

  it("maps a permission-denied error (and anything else) to the permission message", () => {
    const error = new Error("denied");
    error.name = "NotAllowedError";
    expect(mapCameraErrorMessage(error)).toBe("Camera permission is needed to scan reward QR codes.");
  });

  it("falls back to the permission message for a non-Error rejection", () => {
    expect(mapCameraErrorMessage("nope")).toBe("Camera permission is needed to scan reward QR codes.");
  });
});

describe("RedeemSuccessCard", () => {
  it("renders the reward name, consumer name, and redeemed time", () => {
    render(
      <RedeemSuccessCard
        claimId="claim-1"
        rewardName="Free latte"
        consumerName="Maria Santos"
        redeemedAt="2026-07-25T05:30:00.000Z"
        onScanNext={() => {}}
      />,
    );

    expect(screen.getByText("Redeemed")).toBeInTheDocument();
    expect(screen.getByText("Free latte")).toBeInTheDocument();
    expect(screen.getByText("Maria Santos")).toBeInTheDocument();
    expect(screen.getByText("Jul 25, 1:30 PM")).toBeInTheDocument();
  });

  it("calls onScanNext when the Scan next button is pressed", () => {
    const onScanNext = vi.fn();
    render(
      <RedeemSuccessCard
        claimId="claim-1"
        rewardName="Free latte"
        consumerName="Maria Santos"
        redeemedAt="2026-07-25T05:30:00.000Z"
        onScanNext={onScanNext}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Scan next" }));
    expect(onScanNext).toHaveBeenCalledTimes(1);
  });
});

describe("RedeemErrorCard", () => {
  it("renders the staff-facing message verbatim and the code as a caption", () => {
    render(
      <RedeemErrorCard
        message="This reward has already been redeemed."
        code="CLAIM_ALREADY_REDEEMED"
        onRetry={() => {}}
      />,
    );

    expect(screen.getByText("This reward has already been redeemed.")).toBeInTheDocument();
    expect(screen.getByText("CLAIM_ALREADY_REDEEMED")).toBeInTheDocument();
  });

  it("calls onRetry when the Try again button is pressed", () => {
    const onRetry = vi.fn();
    render(<RedeemErrorCard message="Expired." code="CLAIM_EXPIRED" onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("RedeemScanner", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    decodeFromConstraintsMock.mockReset();
    global.fetch = originalFetch;
  });

  it("shows a retry prompt when the camera cannot be started (permission denied / no device)", async () => {
    const deniedError = new Error("denied");
    deniedError.name = "NotAllowedError";
    decodeFromConstraintsMock.mockRejectedValue(deniedError);

    render(<RedeemScanner />);

    expect(
      await screen.findByText("Camera permission is needed to scan reward QR codes."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("retrying after a camera error starts the camera again", async () => {
    const deniedError = new Error("denied");
    deniedError.name = "NotAllowedError";
    decodeFromConstraintsMock.mockRejectedValueOnce(deniedError);
    decodeFromConstraintsMock.mockImplementation(
      () => new Promise(() => {}), // stays "starting" forever - just proving a second call happens
    );

    render(<RedeemScanner />);
    await screen.findByRole("button", { name: "Retry" });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(decodeFromConstraintsMock).toHaveBeenCalledTimes(2));
  });

  it("decodes a QR, POSTs the token, and renders the success card; stops the camera on decode", async () => {
    const stop = vi.fn();
    let decodeCallback: ((result: { getText: () => string } | undefined) => void) | undefined;
    decodeFromConstraintsMock.mockImplementation((_constraints, _video, callback) => {
      decodeCallback = callback;
      return Promise.resolve({ stop });
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          claim_id: "claim-1",
          reward_name: "Free latte",
          consumer_name: "Maria Santos",
          redeemed_at: "2026-07-25T05:30:00.000Z",
        },
      }),
    }) as unknown as typeof fetch;

    render(<RedeemScanner />);
    await waitFor(() => expect(decodeCallback).toBeDefined());

    decodeCallback?.({ getText: () => "token-abc" });

    expect(await screen.findByText("Free latte")).toBeInTheDocument();
    expect(screen.getByText("Maria Santos")).toBeInTheDocument();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/v1/redemptions/validate",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "token-abc" }) }),
    );
  });

  it("ignores a repeat decode of the same token fired while the first request is still in flight", async () => {
    let decodeCallback: ((result: { getText: () => string } | undefined) => void) | undefined;
    decodeFromConstraintsMock.mockImplementation((_constraints, _video, callback) => {
      decodeCallback = callback;
      return Promise.resolve({ stop: vi.fn() });
    });

    let resolveFetch!: (value: unknown) => void;
    global.fetch = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    ) as unknown as typeof fetch;

    render(<RedeemScanner />);
    await waitFor(() => expect(decodeCallback).toBeDefined());

    decodeCallback?.({ getText: () => "token-abc" });
    decodeCallback?.({ getText: () => "token-abc" });
    decodeCallback?.({ getText: () => "token-abc" });

    resolveFetch({
      ok: true,
      json: async () => ({
        data: {
          claim_id: "claim-1",
          reward_name: "Free latte",
          consumer_name: "Maria Santos",
          redeemed_at: "2026-07-25T05:30:00.000Z",
        },
      }),
    });

    await screen.findByText("Free latte");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("renders the mapped error message and code, and Try again resumes scanning", async () => {
    let decodeCallback: ((result: { getText: () => string } | undefined) => void) | undefined;
    decodeFromConstraintsMock.mockImplementation((_constraints, _video, callback) => {
      decodeCallback = callback;
      return Promise.resolve({ stop: vi.fn() });
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: { code: "CLAIM_ALREADY_REDEEMED", message: "This reward has already been redeemed." },
      }),
    }) as unknown as typeof fetch;

    render(<RedeemScanner />);
    await waitFor(() => expect(decodeCallback).toBeDefined());

    decodeCallback?.({ getText: () => "token-abc" });

    expect(await screen.findByText("This reward has already been redeemed.")).toBeInTheDocument();
    expect(screen.getByText("CLAIM_ALREADY_REDEEMED")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(decodeFromConstraintsMock).toHaveBeenCalledTimes(2));
  });
});
