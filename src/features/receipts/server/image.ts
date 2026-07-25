import "server-only";

import sharp from "sharp";

// The sharp seam of doc 36 Stage 1 step 2 and doc 15 "Input & upload safety".
// Everything in this file touches raw image bytes; nothing in it touches the
// database, storage, or a request. That split is deliberate: submit.ts owns the
// authorization, duplicate and persistence rules and is unit-tested against a
// fake of `CanonicalizeReceiptImage`, while the pixel work lives here where it
// can be tested against real bytes produced by sharp itself.
//
// Two jobs, both security-relevant:
//
//   1. sniffImageFormat - decide what the bytes ACTUALLY are. The declared
//      Content-Type is attacker-controlled (it is whatever the client sent to
//      the signed upload URL) and the bucket's allowed_mime_types check in
//      0019_receipts_storage.sql trusts exactly that header, so it is a second
//      fence rather than the truth. Doc 15 requires "content-type + magic-byte
//      sniffing"; this is the magic-byte half, and it is the half that counts.
//
//   2. canonicalizeReceiptImage - re-encode to a canonical JPEG. This is what
//      strips EXIF (and therefore GPS) from a consumer's photo, per doc 15 and
//      RA 10173 data minimisation: location reaches `receipts.submitted_lat`
//      only when the consumer opted in, and an EXIF GPS tag riding along inside
//      the stored object would silently defeat that choice. It also flattens
//      any embedded payload, since only decoded pixels survive the round trip.

/** Doc 15: "receipts <= 10MB". Also the bucket's file_size_limit in 0019. */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

/** Doc 36 Stage 1 / doc 33 Scanner: max 2048px long edge. */
export const CANONICAL_MAX_EDGE = 2048;

/**
 * Doc 33's client compression contract re-encodes at JPEG q0.8 before upload.
 * The server re-encode sits just above that so a canonicalization pass does not
 * visibly degrade an already-compressed photo a second time; quality below the
 * client's would throw away OCR-relevant edge detail on thermal receipts, which
 * is the exact detail Stage 3 preprocessing depends on.
 */
export const CANONICAL_JPEG_QUALITY = 85;

/**
 * The grayscale downsample the perceptual hash is defined over. This is
 * phash.ts's default source size (its frozen convention, point 1: "a size x
 * size grayscale matrix (default 32 x 32)"). It is restated rather than
 * imported because phash.ts keeps its default private on purpose; a test in
 * image.test.ts asserts the two agree by feeding this buffer to `dctPhash`
 * with no explicit size.
 */
export const PHASH_SOURCE_SIZE = 32;

/**
 * The image formats doc 36 Stage 1 accepts ("JPEG, PNG, WebP", with HEIC
 * converted client-side) and 0019's bucket allowed_mime_types mirrors.
 */
export type ReceiptImageFormat = "jpeg" | "png" | "webp";

/** Longest signature below, so a shorter buffer can never be a valid image. */
const MIN_SNIFFABLE_BYTES = 12;

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function matchesAscii(bytes: Uint8Array, offset: number, ascii: string): boolean {
  for (let index = 0; index < ascii.length; index += 1) {
    if (bytes[offset + index] !== ascii.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * What the bytes actually are, or null when they are not one of the three
 * accepted formats. Signatures only: this deliberately does NOT decode, so it
 * stays cheap enough to run before the expensive re-encode and cannot itself be
 * the thing a malicious file attacks.
 */
export function sniffImageFormat(bytes: Uint8Array): ReceiptImageFormat | null {
  if (bytes.length < MIN_SNIFFABLE_BYTES) return null;

  // JPEG: SOI marker FF D8 followed by any marker start FF.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";

  // PNG: the 8-byte signature, including the CR LF / SUB / LF bytes that exist
  // precisely to detect mangled transfers.
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";

  // WebP: a RIFF container whose form type at offset 8 is "WEBP". Checking the
  // form type matters; "RIFF" alone is also WAV and AVI.
  if (matchesAscii(bytes, 0, "RIFF") && matchesAscii(bytes, 8, "WEBP")) return "webp";

  return null;
}

/**
 * The canonical bytes that get stored, plus the pixels the perceptual hash is
 * computed from. They travel together because both must describe the SAME
 * image: `receipts.sha256` and `receipts.image_hash` are compared against each
 * other's history for years (doc 37 S1), so a hash taken from the pre-encode
 * bytes while sha256 was taken from the post-encode bytes would quietly make
 * the two columns describe different pictures.
 */
export interface CanonicalReceiptImage {
  /** Canonical JPEG bytes: what gets stored and what sha256 is computed over. */
  readonly jpeg: Uint8Array;
  /** Row-major 32x32 grayscale, 0-255, ready for `dctPhash`. */
  readonly grayscale: Uint8Array;
}

/**
 * The injectable seam. submit.ts takes this as a dependency so its own tests
 * never load sharp (a native module) and never need real image bytes.
 */
export type CanonicalizeReceiptImage = (
  bytes: Uint8Array,
) => Promise<CanonicalReceiptImage>;

/**
 * Re-encode to canonical JPEG and derive the pHash pixels from the RESULT, not
 * from the input.
 *
 * `.rotate()` with no argument applies the EXIF orientation tag and then lets
 * it be dropped, so the stored pixels are upright. Order matters: sharp writes
 * no metadata unless `.withMetadata()` is called, so calling rotate first is
 * what keeps a phone photo from being stored sideways once its orientation tag
 * is gone. Nothing here ever calls `.withMetadata()`, and it must not start:
 * that single call would re-attach the EXIF block this function exists to
 * remove.
 */
export const canonicalizeReceiptImage: CanonicalizeReceiptImage = async (bytes) => {
  const jpeg = await sharp(Buffer.from(bytes), { failOn: "error" })
    .rotate()
    .resize({
      width: CANONICAL_MAX_EDGE,
      height: CANONICAL_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    // 4:4:4 keeps full chroma resolution. Receipts are thin dark strokes on
    // near-white paper, and the default 4:2:0 subsampling smears exactly that.
    .jpeg({ quality: CANONICAL_JPEG_QUALITY, chromaSubsampling: "4:4:4" })
    .toBuffer();

  // "fit: fill" is required by the frozen pHash convention in phash.ts: the
  // hash is defined over a square 32x32 downsample of the whole image, so the
  // aspect ratio is intentionally not preserved. Preserving it (or padding)
  // would put different content in each cell and change every stored hash.
  const grayscale = await sharp(jpeg)
    .resize(PHASH_SOURCE_SIZE, PHASH_SOURCE_SIZE, { fit: "fill" })
    .greyscale()
    // Force a single-channel raw buffer. Without it a raw() read can carry the
    // source channel count, and dctPhash would reject (or, worse, silently
    // misread) a 3072-byte buffer where it expects 1024.
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  return {
    jpeg: new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength),
    grayscale: new Uint8Array(grayscale.buffer, grayscale.byteOffset, grayscale.byteLength),
  };
};
