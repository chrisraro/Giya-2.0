import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

import { CameraViewfinder, mapCameraError } from "./camera-viewfinder";

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapCameraError", () => {
  it("gives a denied permission real instructions, not just the word denied", () => {
    // Once a browser records a denial it stops prompting, so "permission
    // denied" alone leaves the consumer with no way back to a working scanner.
    const problem = mapCameraError(namedError("NotAllowedError"));

    expect(problem.title).toBe("Camera access is off");
    expect(problem.message).toContain("address bar");
    expect(problem.message).toContain("gallery");
    expect(problem.canRetry).toBe(true);
  });

  it("treats an insecure context the same as a denial", () => {
    expect(mapCameraError(namedError("SecurityError")).title).toBe("Camera access is off");
  });

  it("points a device with no camera at the gallery and offers no retry", () => {
    const problem = mapCameraError(namedError("NotFoundError"));

    expect(problem.title).toBe("No camera found");
    expect(problem.canRetry).toBe(false);
  });

  it("names the real cause when another app holds the camera", () => {
    expect(mapCameraError(namedError("NotReadableError")).title).toBe("The camera is busy");
  });

  it("explains an unsupported browser without offering a retry", () => {
    expect(mapCameraError(namedError("UnsupportedError")).canRetry).toBe(false);
  });

  it("falls back to a retryable generic message", () => {
    expect(mapCameraError("something odd").canRetry).toBe(true);
  });
});

describe("CameraViewfinder", () => {
  it("labels the viewfinder and disables the shutter until the camera is live", async () => {
    // jsdom has no mediaDevices, so this renders the unsupported branch: the
    // accessible name and the disabled shutter must both still be correct.
    render(<CameraViewfinder onCapture={vi.fn()} onCaptureError={vi.fn()} />);

    expect(screen.getByLabelText(/Camera viewfinder/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Take photo/ })).toBeDisabled();
    expect(await screen.findByText("Camera not available here")).toBeInTheDocument();
  });

  it("stops every track when it unmounts", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const { unmount } = render(<CameraViewfinder onCapture={vi.fn()} onCaptureError={vi.fn()} />);

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: "environment" },
    }));
    unmount();

    // Releasing the stream is what turns the phone's camera indicator back off.
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it("renders a permission error with a Try again action", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(namedError("NotAllowedError"));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    render(<CameraViewfinder onCapture={vi.fn()} onCaptureError={vi.fn()} />);

    expect(await screen.findByText("Camera access is off")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
