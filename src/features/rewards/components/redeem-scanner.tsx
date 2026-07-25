"use client";

import * as React from "react";
import { BrowserQRCodeReader } from "@zxing/browser";
import type { IScannerControls } from "@zxing/browser";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

// Staff-facing counter scanner: the other half of the reward loop from
// src/features/rewards/components/redemption-qr.tsx (the consumer's QR
// screen). Continuously decodes QR codes from the environment-facing camera
// via @zxing/browser's BrowserQRCodeReader, POSTs a successful decode to
// /api/v1/redemptions/validate, and renders the resulting success/error
// card. See task-6-report.md for the lifecycle + duplicate-decode guard
// rationale.

type Phase = "starting" | "scanning" | "submitting" | "success" | "error" | "camera-error";

export interface RedeemSuccessResult {
  claimId: string;
  rewardName: string;
  consumerName: string;
  redeemedAt: string;
}

export interface RedeemErrorResult {
  code: string;
  message: string;
}

interface DecodeGuardState {
  inFlight: boolean;
  lastToken: string | null;
}

/**
 * Pure guard deciding whether a freshly decoded token should actually be
 * submitted. A QR code sitting in frame decodes many times per second, so
 * without this guard the same token would be POSTed repeatedly: a duplicate
 * submit would burn the (single-use) token server-side and the second
 * request would come back as a confusing CLAIM_ALREADY_REDEEMED instead of
 * the real result. Exported and pure so it is directly unit-testable
 * without touching the camera at all - see redeem-scanner.test.ts.
 */
export function shouldSubmitDecode(token: string, state: DecodeGuardState): boolean {
  if (!token) return false;
  if (state.inFlight) return false;
  if (state.lastToken === token) return false;
  return true;
}

/** Staff-facing time for a redeemed_at ISO timestamp, in the business's
 * local (Asia/Manila) time. Mirrors src/app/(consumer)/wallet/page.tsx's
 * formatTxnDate convention. */
export function formatRedeemedAt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Staff-facing message for a camera that could not be started. Exported
 * and pure so the mapping is unit-testable without mocking getUserMedia. */
export function mapCameraErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return "No camera was found on this device.";
  }
  return "Camera permission is needed to scan reward QR codes.";
}

export interface RedeemSuccessCardProps extends RedeemSuccessResult {
  onScanNext: () => void;
}

/** Success state: reward + consumer name, redeemed time, "Scan next" reset.
 * Presentational and exported separately so it is testable without
 * rendering the camera-driving parent. */
export function RedeemSuccessCard({
  rewardName,
  consumerName,
  redeemedAt,
  onScanNext,
}: RedeemSuccessCardProps) {
  return (
    <Card
      variant="filled"
      className="flex w-full flex-col items-center gap-2 bg-secondary-container p-8 text-center"
    >
      <span aria-hidden className="material-symbols-rounded is-filled text-[48px] text-on-secondary-container">
        check_circle
      </span>
      <p className="text-title-l text-on-secondary-container">Redeemed</p>
      <p className="text-body-l text-on-secondary-container">{rewardName}</p>
      <p className="text-body-m text-on-secondary-container">{consumerName}</p>
      <p className="text-label-m text-on-secondary-container">{formatRedeemedAt(redeemedAt)}</p>
      <Button type="button" variant="filled" size="touch" onClick={onScanNext} className="mt-3 w-full">
        Scan next
      </Button>
    </Card>
  );
}

export interface RedeemErrorCardProps extends RedeemErrorResult {
  onRetry: () => void;
}

/** Error state: the staff-facing message verbatim, the code as a small
 * caption, and a "Try again" reset. Presentational and exported separately
 * so it is testable without rendering the camera-driving parent. */
export function RedeemErrorCard({ message, code, onRetry }: RedeemErrorCardProps) {
  return (
    <Card variant="outlined" className="flex w-full flex-col items-center gap-2 p-8 text-center">
      <span aria-hidden className="material-symbols-rounded text-[48px] text-error">
        error
      </span>
      <p className="text-body-l text-on-surface">{message}</p>
      <p className="text-label-s text-on-surface-variant">{code}</p>
      <Button type="button" variant="filled" size="touch" onClick={onRetry} className="mt-3 w-full">
        Try again
      </Button>
    </Card>
  );
}

interface ValidateApiResponse {
  data?: {
    claim_id: string;
    reward_name: string;
    consumer_name: string;
    redeemed_at: string;
  };
  error?: {
    code: string;
    message: string;
  };
}

async function submitToken(token: string): Promise<
  { ok: true; result: RedeemSuccessResult } | { ok: false; result: RedeemErrorResult }
> {
  try {
    const response = await fetch("/api/v1/redemptions/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = (await response.json()) as ValidateApiResponse;

    if (!response.ok || !body.data) {
      return {
        ok: false,
        result: {
          code: body.error?.code ?? "UNKNOWN",
          message: body.error?.message ?? "Something went wrong. Please try again.",
        },
      };
    }

    return {
      ok: true,
      result: {
        claimId: body.data.claim_id,
        rewardName: body.data.reward_name,
        consumerName: body.data.consumer_name,
        redeemedAt: body.data.redeemed_at,
      },
    };
  } catch {
    return {
      ok: false,
      result: { code: "NETWORK", message: "Something went wrong. Please try again." },
    };
  }
}

/**
 * Client-driven camera scanner. Starts the environment-facing camera on
 * mount (falls back to a "Try again" prompt if permission is denied or no
 * device is found - kept usable rather than dead-ending), decodes QR frames
 * continuously via @zxing/browser, and on the first fresh decode stops the
 * camera immediately (both to free the device while a request is in flight
 * and, together with shouldSubmitDecode, to make a duplicate submit
 * impossible) and POSTs the token. "Scan next" / "Try again" restart the
 * camera from a clean phase.
 */
export function RedeemScanner() {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const controlsRef = React.useRef<IScannerControls | null>(null);
  const inFlightRef = React.useRef(false);
  const lastTokenRef = React.useRef<string | null>(null);

  const [phase, setPhase] = React.useState<Phase>("starting");
  const [cameraMessage, setCameraMessage] = React.useState<string | null>(null);
  const [successResult, setSuccessResult] = React.useState<RedeemSuccessResult | null>(null);
  const [errorResult, setErrorResult] = React.useState<RedeemErrorResult | null>(null);
  // Bumped by restartScanning() to (re)acquire the camera; see the effect
  // below for why camera acquisition is keyed on this instead of `phase`.
  const [scanSession, setScanSession] = React.useState(0);

  const showCamera = phase === "starting" || phase === "scanning";

  const handleDecode = React.useCallback(async (token: string) => {
    if (!shouldSubmitDecode(token, { inFlight: inFlightRef.current, lastToken: lastTokenRef.current })) {
      return;
    }
    inFlightRef.current = true;
    lastTokenRef.current = token;

    controlsRef.current?.stop();
    controlsRef.current = null;
    setPhase("submitting");

    const outcome = await submitToken(token);
    inFlightRef.current = false;

    if (outcome.ok) {
      setSuccessResult(outcome.result);
      setPhase("success");
    } else {
      setErrorResult(outcome.result);
      setPhase("error");
    }
  }, []);

  // Acquires the camera once per `scanSession` (mount, plus every explicit
  // restart from "Scan next"/"Retry" below) and always releases it on
  // cleanup - covers unmount, StrictMode's double-invoke, and every
  // restart. Deliberately depends on `scanSession`, NOT `phase`: the
  // `.then()` handler below calls setPhase("scanning") once the camera is
  // live, and if this effect depended on `phase` that very setPhase call
  // would re-run the effect and its cleanup would stop() the controls it
  // had just acquired a moment earlier - the camera would start and
  // immediately die on every single scan. `scanSession` only changes when
  // something outside this effect explicitly wants a fresh camera.
  React.useEffect(() => {
    let cancelled = false;

    const reader = new BrowserQRCodeReader();

    reader
      .decodeFromConstraints(
        { video: { facingMode: "environment" } },
        videoRef.current ?? undefined,
        (result) => {
          // The continuous-decode callback also fires a NotFoundException
          // on every frame without a code in view - that is expected noise,
          // not a failure, so only a successful `result` is ever acted on.
          if (cancelled || !result) return;
          void handleDecode(result.getText());
        },
      )
      .then((controls) => {
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        setPhase("scanning");
      })
      .catch((cameraError: unknown) => {
        if (cancelled) return;
        setCameraMessage(mapCameraErrorMessage(cameraError));
        setPhase("camera-error");
      });

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [scanSession, handleDecode]);

  function restartScanning() {
    lastTokenRef.current = null;
    inFlightRef.current = false;
    setSuccessResult(null);
    setErrorResult(null);
    setPhase("starting");
    setScanSession((session) => session + 1);
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4">
      {showCamera ? (
        <div className="relative w-full overflow-hidden rounded-md3-lg bg-surface-container-highest">
          <video
            ref={videoRef}
            aria-label="Camera preview for scanning a reward QR code"
            muted
            playsInline
            className="aspect-square w-full object-cover"
          />
          {phase === "starting" ? (
            <div className="absolute inset-0 flex items-center justify-center bg-scrim/20">
              <p className="rounded-full bg-surface px-4 py-2 text-label-l text-on-surface">
                Starting camera...
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {phase === "submitting" ? (
        <Card variant="outlined" className="flex w-full flex-col items-center gap-3 p-8 text-center">
          <p className="text-body-l text-on-surface">Checking code...</p>
        </Card>
      ) : null}

      {phase === "camera-error" ? (
        <Card variant="outlined" className="flex w-full flex-col items-center gap-3 p-8 text-center">
          <span aria-hidden className="material-symbols-rounded text-[48px] text-on-surface-variant">
            no_photography
          </span>
          <p className="text-body-l text-on-surface">
            {cameraMessage ?? "Camera permission is needed to scan reward QR codes."}
          </p>
          <Button type="button" variant="filled" size="touch" onClick={restartScanning} className="w-full">
            Retry
          </Button>
        </Card>
      ) : null}

      {phase === "success" && successResult ? (
        <RedeemSuccessCard {...successResult} onScanNext={restartScanning} />
      ) : null}

      {phase === "error" && errorResult ? (
        <RedeemErrorCard {...errorResult} onRetry={restartScanning} />
      ) : null}

      {showCamera ? (
        <p className="text-center text-body-s text-on-surface-variant">
          Point the camera at the customer&apos;s reward QR code
        </p>
      ) : null}
    </div>
  );
}
