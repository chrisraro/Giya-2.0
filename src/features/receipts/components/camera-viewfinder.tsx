"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";

import {
  ImageCaptureError,
  browserCompressionEnvironment,
  compressDrawable,
  type CompressedImage,
  type DrawableImage,
} from "../compress";
import { mapCaptureRejection, type CaptureError } from "../upload";

// The live camera half of /scan (doc 33 Scanner step 1: "getUserMedia
// viewfinder with edge-guide overlay when available", gallery pick equally
// supported by the parent).
//
// The stream lifecycle follows src/features/rewards/components/redeem-scanner.tsx,
// including the bug that component's comments record: acquisition is keyed on a
// session counter, NEVER on the component's own phase. If the effect depended on
// phase, the setState that marks the camera live would re-run the effect, whose
// cleanup would stop the tracks it had just acquired, and the camera would die
// the instant it started. `cameraSession` only changes when something explicitly
// asks for a fresh camera.
//
// This component is mounted only while the consumer is composing a shot. The
// parent unmounts it on capture, which is what releases the camera during the
// confirm and upload steps: holding a live stream while an upload runs keeps the
// phone's camera indicator on for no reason and burns battery on the exact
// device class doc 33 budgets for.

export interface CameraProblem {
  readonly title: string;
  readonly message: string;
  /** False when retrying cannot help (no camera hardware, unsupported browser). */
  readonly canRetry: boolean;
}

/**
 * Consumer-facing copy for a camera that will not start. Pure and exported so
 * every branch is unit-testable without mocking getUserMedia.
 *
 * The permission branch carries real instructions rather than "permission
 * denied", because once a browser has recorded a denial it will not prompt
 * again: a consumer who taps "Block" by reflex has no path back to a working
 * scanner unless the UI tells them where the setting lives.
 */
export function mapCameraError(error: unknown): CameraProblem {
  const name = error instanceof Error ? error.name : undefined;

  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return {
      title: "Camera access is off",
      message:
        "Tap the lock or camera icon in your browser address bar, allow the camera for this site, then tap Try again. You can also pick a photo from your gallery.",
      canRetry: true,
    };
  }

  if (
    name === "NotFoundError" ||
    name === "DevicesNotFoundError" ||
    name === "OverconstrainedError"
  ) {
    return {
      title: "No camera found",
      message: "This device has no camera we can use. Pick a photo from your gallery instead.",
      canRetry: false,
    };
  }

  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return {
      title: "The camera is busy",
      message:
        "Another app is using the camera. Close it and tap Try again, or pick a photo from your gallery.",
      canRetry: true,
    };
  }

  if (name === "UnsupportedError") {
    return {
      title: "Camera not available here",
      message:
        "This browser cannot open the camera on this page. Pick a photo from your gallery instead.",
      canRetry: false,
    };
  }

  return {
    title: "The camera did not start",
    message: "Tap Try again, or pick a photo from your gallery instead.",
    canRetry: true,
  };
}

class UnsupportedCameraError extends Error {
  constructor() {
    super("getUserMedia is not available in this browser.");
    this.name = "UnsupportedError";
  }
}

/**
 * Copy the current video frame into a canvas of its own natural size.
 *
 * An intermediate canvas rather than handing the <video> element straight to
 * the compressor: a video's `width`/`height` properties reflect its layout
 * attributes, not its pixel dimensions (`videoWidth`/`videoHeight`), so passing
 * the element would compress against the wrong aspect ratio. A canvas reports
 * true pixels and is itself a valid draw source.
 */
function captureVideoFrame(video: HTMLVideoElement): DrawableImage {
  const frame = document.createElement("canvas");
  frame.width = video.videoWidth;
  frame.height = video.videoHeight;
  const context = frame.getContext("2d");
  if (context === null) {
    throw new ImageCaptureError("encode_failed", "This device could not capture the frame.");
  }
  context.drawImage(video, 0, 0, frame.width, frame.height);
  return frame;
}

export interface CameraViewfinderProps {
  readonly onCapture: (image: CompressedImage) => void;
  readonly onCaptureError: (error: CaptureError) => void;
  /** Disables the shutter while the parent is busy with a previous frame. */
  readonly disabled?: boolean;
}

type CameraPhase = "starting" | "live" | "failed";

export function CameraViewfinder({ onCapture, onCaptureError, disabled }: CameraViewfinderProps) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = React.useState<CameraPhase>("starting");
  const [problem, setProblem] = React.useState<CameraProblem | null>(null);
  const [cameraSession, setCameraSession] = React.useState(0);
  const [capturing, setCapturing] = React.useState(false);

  // Acquire once per cameraSession; always release on cleanup, which covers
  // unmount, StrictMode's double invoke, and every explicit restart. See the
  // file header for why this must not depend on `phase`.
  React.useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    // Captured once: the cleanup below must detach the element this effect
    // attached to, not whatever the ref happens to hold when it runs.
    const attachedVideo = videoRef.current;

    async function start(): Promise<void> {
      if (typeof navigator === "undefined" || navigator.mediaDevices?.getUserMedia === undefined) {
        throw new UnsupportedCameraError();
      }
      // doc 36 Stage 1: the rear camera, which is the one pointed at a receipt.
      const acquired = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      if (cancelled) {
        for (const track of acquired.getTracks()) track.stop();
        return;
      }
      stream = acquired;
      const video = attachedVideo;
      if (video !== null) {
        video.srcObject = acquired;
        // Autoplay can still be refused (a backgrounded tab); the frame simply
        // stays black until the user returns, which is not worth an error card.
        // Wrapped rather than chained because play() is not guaranteed to
        // return a promise outside modern browsers (jsdom returns undefined).
        void Promise.resolve(video.play()).catch(() => {});
      }
      setPhase("live");
    }

    void start().catch((error: unknown) => {
      if (cancelled) return;
      setProblem(mapCameraError(error));
      setPhase("failed");
    });

    return () => {
      cancelled = true;
      if (attachedVideo !== null) attachedVideo.srcObject = null;
      if (stream !== null) {
        for (const track of stream.getTracks()) track.stop();
      }
    };
  }, [cameraSession]);

  async function handleShutter(): Promise<void> {
    const video = videoRef.current;
    if (video === null || capturing) return;

    setCapturing(true);
    try {
      const frame = captureVideoFrame(video);
      const compressed = await compressDrawable(frame, browserCompressionEnvironment());
      onCapture(compressed);
    } catch (error) {
      onCaptureError(
        mapCaptureRejection(error instanceof ImageCaptureError ? error.reason : "encode_failed"),
      );
    } finally {
      setCapturing(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="relative aspect-[3/4] w-full overflow-hidden rounded-md3-lg bg-surface-container-highest">
        <video
          ref={videoRef}
          aria-label="Camera viewfinder. Point the camera at your receipt, then use the Take photo button."
          muted
          playsInline
          autoPlay
          className="h-full w-full object-cover"
        />

        {phase === "live" ? (
          // Edge guide (doc 33 step 1). Decorative: the accessible instruction
          // lives on the video's label and in the caption below.
          <div
            aria-hidden
            className="pointer-events-none absolute inset-6 rounded-md3-md border-2 border-dashed border-outline"
          />
        ) : null}

        {phase === "starting" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-scrim/20">
            <p className="rounded-full bg-surface px-4 py-2 text-label-l text-on-surface">
              Starting camera...
            </p>
          </div>
        ) : null}

        {phase === "failed" && problem !== null ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-container p-6 text-center">
            <span aria-hidden className="material-symbols-rounded text-[40px] text-on-surface-variant">
              no_photography
            </span>
            <p className="text-title-m text-on-surface">{problem.title}</p>
            <p className="text-body-s text-on-surface-variant">{problem.message}</p>
            {problem.canRetry ? (
              <Button
                type="button"
                variant="outlined"
                size="touch"
                className="mt-2"
                onClick={() => {
                  setProblem(null);
                  setPhase("starting");
                  setCameraSession((session) => session + 1);
                }}
              >
                Try again
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <Button
        type="button"
        variant="filled"
        size="touch"
        className="w-full"
        disabled={phase !== "live" || capturing || disabled === true}
        onClick={() => void handleShutter()}
      >
        <span aria-hidden className="material-symbols-rounded">
          photo_camera
        </span>
        {capturing ? "Capturing..." : "Take photo"}
      </Button>
    </div>
  );
}
