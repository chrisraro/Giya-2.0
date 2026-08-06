import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  AVATAR_CANONICAL_EDGE,
  canonicalizeAvatarImage,
  sniffImageFormat,
} from "./avatar-image";

// Real bytes, produced by sharp itself. The point of this file is the one
// property the PUBLIC avatars bucket depends on: what we store is decoded pixels
// and nothing else.

/** A landscape JPEG carrying an EXIF block with a GPS latitude in it. */
async function photoWithGps(): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width: 800, height: 400, channels: 3, background: { r: 200, g: 120, b: 90 } },
  })
    .withExif({
      IFD0: { Software: "giya-test" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "10/1 18/1 0/1" },
    })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buffer);
}

async function plainPng(width = 300, height = 300): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

describe("canonicalizeAvatarImage", () => {
  it("CRITICAL: strips EXIF, so a public avatar cannot carry the GPS tag a camera wrote", async () => {
    const source = await photoWithGps();
    expect((await sharp(Buffer.from(source)).metadata()).exif).toBeDefined();

    const out = await canonicalizeAvatarImage(source);

    expect((await sharp(Buffer.from(out)).metadata()).exif).toBeUndefined();
  });

  it("stores a square at the canonical edge, whatever shape came in", async () => {
    const meta = await sharp(Buffer.from(await canonicalizeAvatarImage(await photoWithGps())))
      .metadata();

    expect(meta.width).toBe(AVATAR_CANONICAL_EDGE);
    expect(meta.height).toBe(AVATAR_CANONICAL_EDGE);
  });

  it("re-encodes to JPEG regardless of the input format", async () => {
    // A PNG in, a JPEG out: the object name's `.jpg` and the bucket's
    // allowed_mime_types both assume exactly one stored format.
    const out = await canonicalizeAvatarImage(await plainPng());

    expect((await sharp(Buffer.from(out)).metadata()).format).toBe("jpeg");
    expect(sniffImageFormat(out)).toBe("jpeg");
  });

  it("enlarges a small source rather than storing an undersized square", async () => {
    const meta = await sharp(Buffer.from(await canonicalizeAvatarImage(await plainPng(64, 64))))
      .metadata();

    expect(meta.width).toBe(AVATAR_CANONICAL_EDGE);
    expect(meta.height).toBe(AVATAR_CANONICAL_EDGE);
  });

  it("CRITICAL: the canonical object lands far under the bucket's 2MB ceiling", async () => {
    // The bucket cap is the fence for the direct Storage-API path; this asserts
    // our own path never has to think about it.
    const out = await canonicalizeAvatarImage(await photoWithGps());

    expect(out.byteLength).toBeLessThan(2 * 1024 * 1024);
  });

  it("rejects bytes that are not a decodable image", async () => {
    await expect(canonicalizeAvatarImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toThrow();
  });
});

describe("sniffImageFormat, re-exported here", () => {
  it("is the same magic-byte reader the receipts path uses, not a second copy", async () => {
    expect(sniffImageFormat(await plainPng())).toBe("png");
    expect(sniffImageFormat(await photoWithGps())).toBe("jpeg");
  });

  it("refuses a file whose bytes are not one of the three accepted formats", () => {
    // An SVG declares itself image/svg+xml and is a script-bearing document; the
    // bucket has no such mime type and the sniff has no such signature.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(sniffImageFormat(svg)).toBeNull();
  });
});
