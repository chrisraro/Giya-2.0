import { describe, it, expect, vi } from "vitest";

import {
  COMPRESSION_LADDER,
  ImageCaptureError,
  MAX_LONG_EDGE_PX,
  MAX_UPLOAD_BYTES,
  PRIMARY_JPEG_QUALITY,
  TARGET_BYTES,
  compressDrawable,
  compressReceiptFile,
  scaleToLongEdge,
  validateCaptureFile,
  type CompressionEnvironment,
  type DrawableImage,
} from "./compress";

// A canvas that records what it was asked to do and produces a blob whose SIZE
// is a deterministic function of pixels x quality. That is the only property of
// a real encoder the ladder logic depends on (smaller/lower quality means fewer
// bytes), so faking it exercises every rule in this module without a DOM.
function fakeEnvironment(options: { bytesPerPixelAtFullQuality?: number } = {}) {
  const perPixel = options.bytesPerPixelAtFullQuality ?? 1;
  const attempts: Array<{ width: number; height: number; quality: number }> = [];

  const environment: CompressionEnvironment = {
    decode: vi.fn(async (): Promise<DrawableImage> => ({ width: 4000, height: 3000 })),
    createCanvas(width, height) {
      return {
        draw: vi.fn(),
        encode: async (quality) => {
          attempts.push({ width, height, quality });
          const size = Math.round(width * height * perPixel * quality);
          return { size } as unknown as Blob;
        },
      };
    },
  };

  return { environment, attempts };
}

describe("validateCaptureFile", () => {
  it("accepts a normal JPEG photo", () => {
    expect(validateCaptureFile({ name: "receipt.jpg", size: 2_000_000, type: "image/jpeg" })).toBeNull();
  });

  it("accepts PNG and WebP, the other two formats doc 36 Stage 1 lists", () => {
    expect(validateCaptureFile({ name: "a.png", size: 1000, type: "image/png" })).toBeNull();
    expect(validateCaptureFile({ name: "a.webp", size: 1000, type: "image/webp" })).toBeNull();
  });

  it("accepts HEIC, which iOS hands over from the photo library", () => {
    expect(validateCaptureFile({ name: "IMG_0001.HEIC", size: 3_000_000, type: "image/heic" })).toBeNull();
  });

  it("accepts a HEIC file an Android picker mislabels, by its extension", () => {
    expect(
      validateCaptureFile({ name: "IMG_0001.heic", size: 1000, type: "application/octet-stream" }),
    ).toBeNull();
  });

  it("rejects anything over the 10MB hard cap", () => {
    expect(
      validateCaptureFile({ name: "burst.jpg", size: MAX_UPLOAD_BYTES + 1, type: "image/jpeg" }),
    ).toBe("too_large");
  });

  it("accepts a file exactly at the 10MB cap", () => {
    expect(
      validateCaptureFile({ name: "big.jpg", size: MAX_UPLOAD_BYTES, type: "image/jpeg" }),
    ).toBeNull();
  });

  it("checks size before format, so an oversized PDF reads as too_large", () => {
    // Ordering matters: doc 33 requires the 10MB refusal to happen before any
    // work, and "too_large" is the more actionable message of the two.
    expect(
      validateCaptureFile({ name: "scan.pdf", size: MAX_UPLOAD_BYTES + 5, type: "application/pdf" }),
    ).toBe("too_large");
  });

  it("rejects a non-image", () => {
    expect(validateCaptureFile({ name: "notes.pdf", size: 1000, type: "application/pdf" })).toBe(
      "unsupported_format",
    );
  });

  it("rejects a zero-byte file", () => {
    expect(validateCaptureFile({ name: "empty.jpg", size: 0, type: "image/jpeg" })).toBe("empty");
  });
});

describe("scaleToLongEdge", () => {
  it("scales a landscape photo down to the 2048px long edge", () => {
    expect(scaleToLongEdge(4000, 3000)).toEqual({ width: 2048, height: 1536 });
  });

  it("scales a portrait photo by its height", () => {
    expect(scaleToLongEdge(3000, 4000)).toEqual({ width: 1536, height: 2048 });
  });

  it("never upscales a photo that is already small", () => {
    expect(scaleToLongEdge(900, 600)).toEqual({ width: 900, height: 600 });
  });

  it("leaves a photo exactly at the long edge untouched", () => {
    expect(scaleToLongEdge(MAX_LONG_EDGE_PX, 1000)).toEqual({ width: MAX_LONG_EDGE_PX, height: 1000 });
  });

  it("keeps at least one pixel on the short edge of an extreme panorama", () => {
    expect(scaleToLongEdge(20_000, 3)).toEqual({ width: 2048, height: 1 });
  });

  it("throws rather than dividing by zero on a dimensionless image", () => {
    expect(() => scaleToLongEdge(0, 0)).toThrow(ImageCaptureError);
  });
});

describe("compressDrawable", () => {
  it("uses doc 33's 2048px / quality 0.8 on the first attempt and stops there when it fits", async () => {
    const { environment, attempts } = fakeEnvironment({ bytesPerPixelAtFullQuality: 0.2 });

    const result = await compressDrawable({ width: 4000, height: 3000 }, environment);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toEqual({ width: 2048, height: 1536, quality: PRIMARY_JPEG_QUALITY });
    expect(result.width).toBe(2048);
    expect(result.quality).toBe(PRIMARY_JPEG_QUALITY);
    expect(result.byteSize).toBeLessThanOrEqual(TARGET_BYTES);
    expect(result.reducedBeyondDefault).toBe(false);
  });

  it("walks the ladder until the result meets the 1.5MB target", async () => {
    // Tuned so 2048@0.8 overshoots and 2048@0.65 fits: quality is spent before
    // resolution, because OCR needs the pixels more than it needs the bitrate.
    const { environment, attempts } = fakeEnvironment({ bytesPerPixelAtFullQuality: 0.6 });

    const result = await compressDrawable({ width: 4000, height: 3000 }, environment);

    expect(attempts.map((attempt) => attempt.quality)).toEqual([0.8, 0.65]);
    expect(result.width).toBe(2048);
    expect(result.quality).toBe(0.65);
    expect(result.byteSize).toBeLessThanOrEqual(TARGET_BYTES);
    expect(result.reducedBeyondDefault).toBe(true);
  });

  it("returns the smallest result rather than failing when no rung meets the target", async () => {
    // A pathological encoder: every rung overshoots. An oversized upload is a
    // slower scan; a failed upload is no scan at all.
    const { environment, attempts } = fakeEnvironment({ bytesPerPixelAtFullQuality: 50 });

    const result = await compressDrawable({ width: 4000, height: 3000 }, environment);

    expect(attempts).toHaveLength(COMPRESSION_LADDER.length);
    expect(result.byteSize).toBeGreaterThan(TARGET_BYTES);
    expect(result.width).toBe(1280);
    expect(result.quality).toBe(0.5);
  });

  it("throws encode_failed when the canvas produces no bytes", async () => {
    const environment: CompressionEnvironment = {
      decode: vi.fn(),
      createCanvas: () => ({ draw: vi.fn(), encode: async () => null }),
    };

    await expect(compressDrawable({ width: 100, height: 100 }, environment)).rejects.toMatchObject({
      reason: "encode_failed",
    });
  });
});

describe("compressReceiptFile", () => {
  function fakeFile(size: number, type = "image/jpeg", name = "receipt.jpg"): File {
    return { size, type, name } as unknown as File;
  }

  it("rejects a file over 10MB WITHOUT decoding it", async () => {
    const { environment } = fakeEnvironment();

    await expect(
      compressReceiptFile(fakeFile(MAX_UPLOAD_BYTES + 1), environment),
    ).rejects.toMatchObject({ reason: "too_large" });
    expect(environment.decode).not.toHaveBeenCalled();
  });

  it("rejects an unsupported format without decoding it", async () => {
    const { environment } = fakeEnvironment();

    await expect(
      compressReceiptFile(fakeFile(1000, "application/pdf", "a.pdf"), environment),
    ).rejects.toMatchObject({ reason: "unsupported_format" });
    expect(environment.decode).not.toHaveBeenCalled();
  });

  it("surfaces a decoder refusal (HEIC off iOS) as decode_failed", async () => {
    const { environment } = fakeEnvironment();
    const failing: CompressionEnvironment = {
      ...environment,
      decode: vi.fn(async () => {
        throw new ImageCaptureError("decode_failed", "nope");
      }),
    };

    await expect(
      compressReceiptFile(fakeFile(1000, "image/heic", "IMG.heic"), failing),
    ).rejects.toMatchObject({ reason: "decode_failed" });
  });

  it("releases the decoded bitmap even when compression throws", async () => {
    const close = vi.fn();
    const environment: CompressionEnvironment = {
      decode: async () => ({ width: 100, height: 100, close }),
      createCanvas: () => ({ draw: vi.fn(), encode: async () => null }),
    };

    await expect(compressReceiptFile(fakeFile(1000), environment)).rejects.toBeInstanceOf(
      ImageCaptureError,
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});
