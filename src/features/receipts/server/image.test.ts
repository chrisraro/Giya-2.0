// @vitest-environment node
//
// Real sharp, real bytes. This file is the reason submit.test.ts is allowed to
// fake the canonicalizer: the privacy-critical claims (EXIF/GPS is gone, the
// stored object is a JPEG, the pHash pixels are the shape phash.ts demands) are
// only meaningful when asserted against an actual decoder.

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

// "server-only" throws outside Next's react-server condition, which vitest does
// not set.
vi.mock("server-only", () => ({}));

import { dctPhash, PHASH_HASH_HEX_LENGTH } from "../phash";
import {
  CANONICAL_MAX_EDGE,
  PHASH_SOURCE_SIZE,
  RECEIPT_MAX_BYTES,
  canonicalizeReceiptImage,
  sniffImageFormat,
} from "./image";

async function makeImage(
  format: "jpeg" | "png" | "webp",
  width = 120,
  height = 80,
): Promise<Uint8Array> {
  const image = sharp({
    create: { width, height, channels: 3, background: { r: 210, g: 190, b: 170 } },
  });
  const buffer =
    format === "jpeg"
      ? await image.jpeg().toBuffer()
      : format === "png"
        ? await image.png().toBuffer()
        : await image.webp().toBuffer();
  return new Uint8Array(buffer);
}

describe("sniffImageFormat", () => {
  it("identifies the three formats doc 36 Stage 1 accepts", async () => {
    expect(sniffImageFormat(await makeImage("jpeg"))).toBe("jpeg");
    expect(sniffImageFormat(await makeImage("png"))).toBe("png");
    expect(sniffImageFormat(await makeImage("webp"))).toBe("webp");
  });

  it("rejects bytes that are not an image at all", () => {
    const html = new TextEncoder().encode("<html><body>not an image</body></html>");
    expect(sniffImageFormat(html)).toBeNull();
  });

  it("rejects a RIFF container that is not WebP", () => {
    // "RIFF....WAVE": the same container, a completely different payload. A
    // sniffer that only looked for "RIFF" would accept this.
    const riff = new Uint8Array(16);
    riff.set(new TextEncoder().encode("RIFF"), 0);
    riff.set(new TextEncoder().encode("WAVE"), 8);
    expect(sniffImageFormat(riff)).toBeNull();
  });

  it("rejects a buffer too short to carry any signature", () => {
    expect(sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffImageFormat(new Uint8Array(0))).toBeNull();
  });
});

describe("canonicalizeReceiptImage", () => {
  it("re-encodes any accepted format to JPEG", async () => {
    for (const format of ["jpeg", "png", "webp"] as const) {
      const { jpeg } = await canonicalizeReceiptImage(await makeImage(format));
      expect(sniffImageFormat(jpeg)).toBe("jpeg");
    }
  });

  it("strips EXIF, which is what removes an embedded GPS tag (doc 15)", async () => {
    const base = await makeImage("jpeg");
    const tagged = await sharp(Buffer.from(base))
      .withExif({ IFD0: { Copyright: "Giya test", Software: "camera" } })
      .jpeg()
      .toBuffer();

    // Guard the guard: the fixture must actually carry EXIF, or the assertion
    // below would pass for the wrong reason.
    expect((await sharp(tagged).metadata()).exif).toBeDefined();

    const { jpeg } = await canonicalizeReceiptImage(new Uint8Array(tagged));

    expect((await sharp(Buffer.from(jpeg)).metadata()).exif).toBeUndefined();
  });

  it("downscales to the 2048px long edge and leaves smaller images alone", async () => {
    const large = await canonicalizeReceiptImage(await makeImage("jpeg", 3000, 1500));
    const largeMeta = await sharp(Buffer.from(large.jpeg)).metadata();
    expect(largeMeta.width).toBe(CANONICAL_MAX_EDGE);
    expect(largeMeta.height).toBe(1024);

    const small = await canonicalizeReceiptImage(await makeImage("jpeg", 120, 80));
    const smallMeta = await sharp(Buffer.from(small.jpeg)).metadata();
    expect(smallMeta.width).toBe(120);
    expect(smallMeta.height).toBe(80);
  });

  it("produces exactly the pixel buffer dctPhash expects with no explicit size", async () => {
    const { grayscale } = await canonicalizeReceiptImage(await makeImage("jpeg"));

    expect(grayscale).toBeInstanceOf(Uint8Array);
    expect(grayscale.length).toBe(PHASH_SOURCE_SIZE * PHASH_SOURCE_SIZE);
    // The contract that matters: phash.ts's default source size agrees with
    // ours, so this buffer hashes without the call site having to say "32".
    expect(dctPhash(grayscale)).toHaveLength(PHASH_HASH_HEX_LENGTH);
  });

  it("is deterministic, so the same photo always yields the same hashes", async () => {
    const source = await makeImage("png", 400, 260);
    const first = await canonicalizeReceiptImage(source);
    const second = await canonicalizeReceiptImage(source);

    expect(Buffer.from(first.jpeg).equals(Buffer.from(second.jpeg))).toBe(true);
    expect(dctPhash(first.grayscale)).toBe(dctPhash(second.grayscale));
  });

  it("rejects bytes it cannot decode rather than inventing an image", async () => {
    // A valid JPEG signature wrapped around nothing. The sniffer accepts this
    // by design (signatures only); the decoder is the layer that refuses it,
    // which is why submit.ts treats a canonicalization throw as a 400.
    const truncated = new Uint8Array(32);
    truncated.set([0xff, 0xd8, 0xff, 0xe0], 0);
    await expect(canonicalizeReceiptImage(truncated)).rejects.toThrow();
  });

  it("states doc 15's 10MB receipt cap", () => {
    expect(RECEIPT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});
