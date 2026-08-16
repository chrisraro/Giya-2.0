"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button, buttonVariants } from "@/components/ui/button";
import { LinearProgress } from "@/components/ui/progress";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import {
  FILE_INPUT_ACCEPT,
  ImageCaptureError,
  clientSha256,
  compressReceiptFile,
  validateCaptureFile,
  type CompressedImage,
} from "../compress";
import {
  mapCaptureRejection,
  newIdempotencyKey,
  submitCapturedReceipt,
  type CaptureError,
} from "../upload";
import { CameraViewfinder } from "./camera-viewfinder";

// /scan, the core consumer flow (doc 33 "Receipt scanner", doc 36 Stage 1).
//
// State machine:
//
//   idle ------- camera available ----> capturing   (derived, see below)
//   idle/capturing -- photo taken or picked --> confirming
//   confirming -- retake --------------> idle
//   confirming -- use this photo ------> uploading
//   uploading -- 202 ------------------> /scan/{receiptId}
//   uploading -- failure --------------> error
//   error -- try again (same key) -----> uploading
//   error -- take another photo -------> idle
//
// `capturing` is DERIVED from `idle` plus camera availability rather than being
// entered by a setState, so there is no render-time read of `navigator` (the
// server has none) and no post-hydration state flip. Availability comes from
// useSyncExternalStore, whose server snapshot is "no camera": the server-side
// HTML is therefore the gallery-only view, and React swaps in the viewfinder
// after hydration without a mismatch. On a phone the viewfinder is live
// immediately, which is the whole point of the screen - doc 33 budgets under 15
// seconds of user effort and the consumer already expressed intent by tapping
// Scan.
//
// The single most important invariant on this screen is the Idempotency-Key.
// It is minted ONCE, when the consumer confirms the photo, and held in
// `submissionRef` until that submission either succeeds or is abandoned for a
// new photo. Every retry reuses it, so a retry after a timeout replays the
// original 202 instead of filing a second receipt for the same purchase. A key
// generated per attempt would defeat the entire header. The uploaded
// `image_path` is held in the same ref for the same reason: the shared handler
// fingerprints the request body, so a retry that re-uploaded to a fresh path
// would be answered 409 IDEMPOTENCY_REPLAYED rather than replayed.

type Phase = "idle" | "capturing" | "confirming" | "uploading" | "error";

interface Preview {
  readonly image: CompressedImage;
  /** null where the browser has no object URLs; the flow still works. */
  readonly url: string | null;
  readonly sha256: string | undefined;
}

interface Submission {
  readonly key: string;
  /**
   * Frozen at the first attempt, alongside the key and for the same reason: the
   * advisory hash resolves asynchronously, so a retry that picked it up late
   * would change the request body under an unchanged Idempotency-Key and be
   * answered 409 IDEMPOTENCY_REPLAYED.
   */
  readonly clientSha256: string | undefined;
  imagePath: string | null;
}

function createPreviewUrl(blob: Blob): string | null {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  try {
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

function releasePreviewUrl(url: string | null): void {
  if (url === null || typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(url);
}

/** True where a live viewfinder is even possible; false in insecure contexts and older WebViews. */
export function cameraIsSupported(): boolean {
  return typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined;
}

/**
 * Camera availability never changes for the life of a page, so the store has
 * nothing to subscribe to. useSyncExternalStore is used purely for its
 * server-snapshot contract; see the header note on hydration.
 */
const NEVER_CHANGES = () => () => {};
const NO_CAMERA_ON_SERVER = () => false;

/**
 * What the polite live region says for a phase. Failures deliberately announce
 * nothing here: the error card carries role="alert" and announces itself
 * assertively, and a second polite announcement of the same event would read
 * the consumer their bad news twice.
 */
export function phaseAnnouncement(phase: Phase): string {
  if (phase === "confirming") return "Photo captured. Check it, then send it or retake it.";
  if (phase === "uploading") return "Sending your receipt.";
  return "";
}

export interface ReceiptCaptureProps {
  /**
   * Pre-bound business from `/scan?business={id}` (doc 33: the business page
   * Scan CTA, and the common path). Sent with the submission so doc 36 Stage 5
   * verifies rather than guesses the merchant.
   */
  readonly businessId?: string | undefined;
  /** Renders the dev-only OCR stub note. The page decides; see scan-entry.ts. */
  readonly showOcrStubNote?: boolean | undefined;
}

export function ReceiptCapture({ businessId, showOcrStubNote }: ReceiptCaptureProps) {
  const router = useRouter();
  const submissionRef = React.useRef<Submission | null>(null);
  const inFlightRef = React.useRef(false);
  const previewUrlRef = React.useRef<string | null>(null);

  const [storedPhase, setPhase] = React.useState<Phase>("idle");
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [error, setError] = React.useState<CaptureError | null>(null);
  const [preparing, setPreparing] = React.useState(false);

  const cameraSupported = React.useSyncExternalStore(
    NEVER_CHANGES,
    cameraIsSupported,
    NO_CAMERA_ON_SERVER,
  );
  const phase: Phase = storedPhase === "idle" && cameraSupported ? "capturing" : storedPhase;

  // The object URL outlives any single render, so it is released from a ref on
  // unmount rather than from an effect keyed on the preview.
  React.useEffect(() => {
    return () => releasePreviewUrl(previewUrlRef.current);
  }, []);

  function acceptImage(image: CompressedImage): void {
    releasePreviewUrl(previewUrlRef.current);
    const url = createPreviewUrl(image.blob);
    previewUrlRef.current = url;
    // A new photo is a new submission: the previous key (and any bytes already
    // uploaded under it) belong to a receipt the consumer decided against.
    submissionRef.current = null;
    setError(null);
    setPreview({ image, url, sha256: undefined });
    setPhase("confirming");

    // Advisory only (doc 33 step 3), so it is computed off the critical path and
    // simply omitted if it is not ready or not supported.
    void clientSha256(image.blob).then((hash) => {
      setPreview((current) =>
        current === null || current.image !== image ? current : { ...current, sha256: hash },
      );
    });
  }

  function failWith(captureError: CaptureError): void {
    setError(captureError);
    setPhase("error");
  }

  async function handleFileSelected(file: File): Promise<void> {
    // Doc 33: the 10MB cap is enforced BEFORE any work. Decoding a 40MB photo
    // to reject it afterwards can take the tab down on a mid-range phone.
    const rejection = validateCaptureFile(file);
    if (rejection !== null) {
      failWith(mapCaptureRejection(rejection));
      return;
    }

    setPreparing(true);
    try {
      acceptImage(await compressReceiptFile(file));
    } catch (compressionError) {
      failWith(
        mapCaptureRejection(
          compressionError instanceof ImageCaptureError ? compressionError.reason : "decode_failed",
        ),
      );
    } finally {
      setPreparing(false);
    }
  }

  async function runSubmit(): Promise<void> {
    // A double tap lands before the re-render that hides the button, and the
    // second call would race the first for the same key.
    if (preview === null || inFlightRef.current) return;
    inFlightRef.current = true;

    // Minted ONCE per submission and reused by every retry: see the file
    // header. Retaking clears the ref, which is what makes the next photo a
    // genuinely new submission.
    const submission: Submission = submissionRef.current ?? {
      key: newIdempotencyKey(),
      clientSha256: preview.sha256,
      imagePath: null,
    };
    submissionRef.current = submission;

    setPhase("uploading");
    const outcome = await submitCapturedReceipt({
      blob: preview.image.blob,
      idempotencyKey: submission.key,
      businessId,
      clientSha256: submission.clientSha256,
      imagePath: submission.imagePath,
    });
    submission.imagePath = outcome.imagePath;
    inFlightRef.current = false;

    if (outcome.ok) {
      router.push(`/scan/${outcome.receiptId}`);
      return;
    }
    failWith(outcome.error);
  }

  function restart(): void {
    releasePreviewUrl(previewUrlRef.current);
    previewUrlRef.current = null;
    submissionRef.current = null;
    inFlightRef.current = false;
    setPreview(null);
    setError(null);
    setPhase("idle");
  }

  const showCaptureSources = phase === "idle" || phase === "capturing";
  const announcement = phaseAnnouncement(phase);

  return (
    <div className="flex w-full flex-col gap-4">
      {showOcrStubNote === true ? <OcrStubNote /> : null}

      {businessId !== undefined ? (
        <p className="text-body-s text-on-surface-variant">
          This receipt will be sent to the store you came from.
        </p>
      ) : null}

      {phase === "capturing" ? (
        <CameraViewfinder
          onCapture={acceptImage}
          onCaptureError={failWith}
          disabled={preparing}
        />
      ) : null}

      {phase === "idle" ? (
        <Card
          variant="outlined"
          className="flex aspect-[3/4] w-full flex-col items-center justify-center gap-2 p-6 text-center"
        >
          <span aria-hidden className="material-symbols-rounded text-[40px] text-on-surface-variant">
            receipt_long
          </span>
          <p className="text-title-m text-on-surface">Add your receipt</p>
          <p className="text-body-s text-on-surface-variant">
            This browser cannot open the camera here. Pick a photo from your gallery instead.
          </p>
        </Card>
      ) : null}

      {showCaptureSources ? (
        <div className="flex flex-col gap-2">
          {/* The input stays a real, focusable control (sr-only, never
              display:none) so it is reachable by keyboard and by assistive
              tech; the label is the visible styled button. */}
          <input
            id="receipt-gallery-input"
            type="file"
            accept={FILE_INPUT_ACCEPT}
            disabled={preparing}
            className="peer sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared so picking the SAME file again still fires a change.
              event.target.value = "";
              if (file !== undefined) void handleFileSelected(file);
            }}
          />
          <label
            htmlFor="receipt-gallery-input"
            className={cn(
              buttonVariants({ variant: "outlined", size: "touch" }),
              "w-full cursor-pointer",
              "peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface",
              preparing && "pointer-events-none opacity-40",
            )}
          >
            <span aria-hidden className="material-symbols-rounded">
              photo_library
            </span>
            {preparing ? "Preparing photo..." : "Choose from gallery"}
          </label>
          <p className="text-center text-body-s text-on-surface-variant">
            Keep the whole receipt in frame, including the total.
          </p>
        </div>
      ) : null}

      {preview !== null && phase !== "idle" && phase !== "capturing" ? (
        <div className="flex w-full flex-col gap-4">
          <CapturePreview preview={preview} dimmed={phase !== "confirming"} />

          {phase === "confirming" ? (
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="filled"
                size="touch"
                className="w-full"
                onClick={() => void runSubmit()}
              >
                Use this photo
              </Button>
              <Button
                type="button"
                variant="text"
                size="touch"
                className="w-full"
                onClick={restart}
              >
                Retake
              </Button>
            </div>
          ) : null}

          {/* Upload is the longest wait a consumer meets in this app: a photo
              over a mobile connection. A bare line of text gave no sense that
              anything was happening. Indeterminate, not determinate, because
              the upload reports no real fraction and a fabricated percentage
              would be a lie. The text stays -- the bar says "working", the
              sentence says what is working. */}
          {phase === "uploading" ? (
            <div className="flex flex-col gap-2">
              <LinearProgress label="Sending your receipt" />
              <p className="text-center text-body-m text-on-surface-variant">
                Sending your receipt...
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {phase === "error" && error !== null ? (
        <CaptureErrorCard
          error={error}
          onRetry={() => void runSubmit()}
          onRestart={restart}
          canRetry={error.retryable && preview !== null}
        />
      ) : null}

      {/* Phase changes are announced politely; failures are announced by the
          error card's own role="alert". */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

function CapturePreview({ preview, dimmed }: { preview: Preview | null; dimmed: boolean }) {
  return (
    <div
      className={cn(
        "relative aspect-[3/4] w-full overflow-hidden rounded-md3-lg bg-surface-container-highest",
        dimmed && "opacity-60",
      )}
    >
      {preview !== null && preview.url !== null ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local object URL for bytes that never leave the device until submit; next/image cannot optimize a blob
        <img
          src={preview.url}
          alt="The receipt photo you just captured"
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center p-6 text-center">
          <p className="text-body-m text-on-surface-variant">Your photo is ready to send.</p>
        </div>
      )}
    </div>
  );
}

interface CaptureErrorCardProps {
  readonly error: CaptureError;
  readonly onRetry: () => void;
  readonly onRestart: () => void;
  readonly canRetry: boolean;
}

/** Exported for direct testing of the error matrix rendering. */
export function CaptureErrorCard({ error, onRetry, onRestart, canRetry }: CaptureErrorCardProps) {
  const waiting = error.kind === "blocked" || error.kind === "rate_limited";

  return (
    <Card
      variant="outlined"
      role="alert"
      className="flex w-full flex-col items-center gap-2 p-6 text-center"
    >
      <span aria-hidden className="material-symbols-rounded text-[40px] text-error">
        {waiting ? "hourglass_top" : "error"}
      </span>
      <p className="text-title-m text-on-surface">{error.title}</p>
      <p className="text-body-m text-on-surface-variant">{error.message}</p>

      {canRetry ? (
        <Button type="button" variant="filled" size="touch" className="mt-2 w-full" onClick={onRetry}>
          Try again
        </Button>
      ) : null}

      {error.kind === "unauthenticated" ? (
        <Link
          href="/login"
          className={cn(buttonVariants({ variant: "filled", size: "touch" }), "mt-2 w-full")}
        >
          Sign in
        </Link>
      ) : (
        <Button
          type="button"
          variant={canRetry ? "text" : "filled"}
          size="touch"
          className="mt-2 w-full"
          onClick={onRestart}
        >
          {waiting ? "Start over" : "Take another photo"}
        </Button>
      )}
    </Card>
  );
}

/**
 * Dev-only marker for the stub OCR provider (spec section 2: the stub "always
 * writes engine='stub' so stub data is never mistaken for real OCR, and the
 * scan UI shows a dev-only note when active"). Rendering is decided on the
 * server by shouldShowOcrStubNote, which is false in production regardless of
 * configuration, so this can never reach a consumer.
 */
function OcrStubNote() {
  return (
    <Card variant="filled" className="flex flex-col gap-1 p-3">
      <p className="text-label-l text-on-surface">Dev only: OCR stub active</p>
      <p className="text-body-s text-on-surface-variant">
        OCR_SERVICE_URL is not set, so receipts are read by the deterministic stub. Results are
        fabricated and are not real OCR output.
      </p>
    </Card>
  );
}
