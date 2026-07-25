// Client-side capture validation and compression, per the canonical contract in
// docs/30-modules/33-consumer-pwa.md (Scanner, step 3) restated by doc 36
// Stage 1: max 2048px long edge, JPEG quality 0.8, target <= 1.5MB, hard 10MB
// reject before any work, accepted formats JPEG/PNG/WebP with HEIC converted
// client-side.
//
// Why the client compresses at all, given the server re-encodes with sharp
// anyway: a modern phone photo is 4-8MB and the consumer is on mobile data in a
// store. Shipping 6MB to make the server throw most of it away is the
// difference between a scan that feels instant and one the user abandons.
//
// Everything here is written against two tiny structural interfaces
// (`DrawableImage`, `EncodeCanvas`) rather than against `HTMLCanvasElement`
// directly, so the sizing/ladder logic - the part with the actual rules in it -
// is unit-testable with a fake canvas. `browserCompressionEnvironment()` is the
// only part that touches the DOM.

/** doc 33: "max long edge 2048px". */
export const MAX_LONG_EDGE_PX = 2048;
/** doc 33: "quality 0.8". The first attempt always uses exactly this. */
export const PRIMARY_JPEG_QUALITY = 0.8;
/** doc 33: "target <= 1.5MB". A target, not a limit: see COMPRESSION_LADDER. */
export const TARGET_BYTES = 1_500_000;
/** doc 15 / doc 33: hard cap 10MB, rejected client-side before any work. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Accepted input formats (doc 36 Stage 1: "JPEG, PNG, WebP; HEIC converted
 * client-side"). HEIC is listed because iOS hands it over from the photo
 * library; whether this browser can actually decode it is a separate question
 * answered by the decoder, not by the mime type.
 */
export const ACCEPTED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

const ACCEPTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"] as const;

/**
 * The `accept` attribute for the gallery input. Extensions are listed alongside
 * the mime types on purpose: some Android pickers report HEIC as
 * `application/octet-stream`, and a mime-only accept list hides those files from
 * the picker entirely.
 */
export const FILE_INPUT_ACCEPT = [...ACCEPTED_MIME_TYPES, ...ACCEPTED_EXTENSIONS].join(",");

export type CaptureRejectionReason =
  /** A zero-byte file: an interrupted share, or a picker that returned nothing. */
  | "empty"
  /** Over the 10MB hard cap. */
  | "too_large"
  /** Not one of the accepted formats. */
  | "unsupported_format"
  /** The format is accepted but this browser could not decode it (HEIC off iOS). */
  | "decode_failed"
  /** Canvas produced no bytes: no 2d context, or toBlob returned null. */
  | "encode_failed";

/** A capture that cannot become an upload, carrying the reason the UI maps to copy. */
export class ImageCaptureError extends Error {
  readonly reason: CaptureRejectionReason;

  constructor(reason: CaptureRejectionReason, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ImageCaptureError";
    this.reason = reason;
  }
}

/** The subset of `File` this module needs, so validation is testable without one. */
export interface CaptureFileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function hasAcceptedMimeType(type: string): boolean {
  const lower = type.toLowerCase().trim();
  return (ACCEPTED_MIME_TYPES as readonly string[]).includes(lower);
}

/**
 * Doc 33's pre-flight, in the order the doc puts it: size before format, and
 * both before any decoding. A 40MB burst-mode photo must be refused without
 * ever being handed to `createImageBitmap`, which would otherwise decode it
 * into ~200MB of RGBA on a mid-range Android and take the tab down with it.
 *
 * Format acceptance is deliberately permissive - mime OR extension. The
 * authoritative check is the server's magic-byte sniff
 * (src/features/receipts/server/image.ts); this one exists to give a friendly
 * answer before an upload, not to be a security boundary, and being strict here
 * would only turn "HEIC reported as application/octet-stream by an Android
 * picker" into a false rejection of a perfectly good photo.
 */
export function validateCaptureFile(file: CaptureFileLike): CaptureRejectionReason | null {
  if (file.size <= 0) return "empty";
  if (file.size > MAX_UPLOAD_BYTES) return "too_large";
  if (!hasAcceptedMimeType(file.type) && !hasAcceptedExtension(file.name)) {
    return "unsupported_format";
  }
  return null;
}

/**
 * Fit `width` x `height` inside a `maxLongEdge` box, preserving aspect ratio.
 * Never upscales: a 900px photo of a faded thermal receipt gains no detail from
 * being blown up to 2048px, it only gains bytes.
 */
export function scaleToLongEdge(
  width: number,
  height: number,
  maxLongEdge: number = MAX_LONG_EDGE_PX,
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= 0) {
    throw new ImageCaptureError("decode_failed", "That photo has no dimensions.");
  }
  if (longEdge <= maxLongEdge) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const ratio = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

export interface CompressionAttempt {
  readonly longEdge: number;
  readonly quality: number;
}

/**
 * Attempt ladder. The FIRST rung is doc 33's contract verbatim (2048px / q0.8)
 * and is the only rung a normal receipt photo ever reaches. The rest exist
 * because 2048px/0.8 is not a guarantee: a dense, high-contrast receipt shot
 * under fluorescent light can still land above 1.5MB, and doc 33 states 1.5MB
 * as the target to hit, not as a number to report missing.
 *
 * Quality is spent before resolution on purpose. OCR accuracy (doc 36 Stage 4)
 * depends far more on how many pixels the printed characters occupy than on
 * JPEG ringing around them, so shrinking the raster is the last thing tried.
 */
export const COMPRESSION_LADDER: readonly CompressionAttempt[] = [
  { longEdge: MAX_LONG_EDGE_PX, quality: PRIMARY_JPEG_QUALITY },
  { longEdge: MAX_LONG_EDGE_PX, quality: 0.65 },
  { longEdge: 1600, quality: 0.6 },
  { longEdge: 1280, quality: 0.5 },
];

/** Anything with pixel dimensions the environment knows how to draw. */
export interface DrawableImage {
  readonly width: number;
  readonly height: number;
  /** Releases decoder memory (ImageBitmap.close); absent on other sources. */
  close?: () => void;
}

/** A canvas already sized to the target dimensions. */
export interface EncodeCanvas {
  draw(image: DrawableImage, width: number, height: number): void;
  /** JPEG bytes at `quality`, or null when the encoder produced nothing. */
  encode(quality: number): Promise<Blob | null>;
}

export interface CompressionEnvironment {
  createCanvas(width: number, height: number): EncodeCanvas;
  decode(source: Blob): Promise<DrawableImage>;
}

export interface CompressedImage {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  readonly quality: number;
  readonly byteSize: number;
  /** True when the ladder had to go past doc 33's 2048/0.8 rung. */
  readonly reducedBeyondDefault: boolean;
}

/**
 * Re-encode an already-decoded image to a JPEG that meets doc 33's contract.
 * Walks COMPRESSION_LADDER and returns the first result at or under the 1.5MB
 * target; if every rung overshoots, the smallest result is returned rather than
 * failing. A 1.6MB upload is a slower scan, and a rejected upload is no scan at
 * all - and the server's real limit is 10MB, which the last rung cannot reach.
 */
export async function compressDrawable(
  image: DrawableImage,
  environment: CompressionEnvironment,
): Promise<CompressedImage> {
  let best: CompressedImage | null = null;

  for (const [index, attempt] of COMPRESSION_LADDER.entries()) {
    const size = scaleToLongEdge(image.width, image.height, attempt.longEdge);
    const canvas = environment.createCanvas(size.width, size.height);
    canvas.draw(image, size.width, size.height);
    const blob = await canvas.encode(attempt.quality);

    if (blob === null) {
      throw new ImageCaptureError("encode_failed", "We could not process that photo.");
    }

    const candidate: CompressedImage = {
      blob,
      width: size.width,
      height: size.height,
      quality: attempt.quality,
      byteSize: blob.size,
      reducedBeyondDefault: index > 0,
    };

    if (candidate.byteSize <= TARGET_BYTES) return candidate;
    if (best === null || candidate.byteSize < best.byteSize) best = candidate;
  }

  if (best === null) {
    throw new ImageCaptureError("encode_failed", "We could not process that photo.");
  }
  return best;
}

/**
 * The whole client-side path for one picked file: validate, decode, re-encode.
 * Throws `ImageCaptureError` for every outcome the UI has copy for.
 */
export async function compressReceiptFile(
  file: File,
  environment: CompressionEnvironment = browserCompressionEnvironment(),
): Promise<CompressedImage> {
  const rejection = validateCaptureFile(file);
  if (rejection !== null) {
    throw new ImageCaptureError(rejection, `That photo was rejected: ${rejection}.`);
  }

  const decoded = await environment.decode(file);
  try {
    return await compressDrawable(decoded, environment);
  } finally {
    decoded.close?.();
  }
}

// ---------------------------------------------------------------------------
// Browser environment
// ---------------------------------------------------------------------------

/**
 * Decode via `createImageBitmap` when available, falling back to an
 * `HTMLImageElement`.
 *
 * The fallback is what makes HEIC work: iOS Safari decodes HEIC with the system
 * decoder behind both paths, so an iPhone photo picked from the library
 * converts to JPEG here without a wasm polyfill. Every other browser refuses,
 * and refuses in the one way this function can detect - the decode rejects or
 * the image errors - which becomes `decode_failed` and, upstream, a clear "this
 * device cannot read HEIC photos" message rather than a silent failure or a
 * blank upload.
 */
async function decodeInBrowser(source: Blob): Promise<DrawableImage> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(source);
    } catch {
      // Fall through to the element decoder: some browsers reject bitmaps for
      // formats their <img> pipeline still handles.
    }
  }

  if (typeof URL.createObjectURL !== "function" || typeof Image !== "function") {
    throw new ImageCaptureError("decode_failed", "This browser cannot read that photo format.");
  }

  const objectUrl = URL.createObjectURL(source);
  try {
    return await new Promise<DrawableImage>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () =>
        reject(
          new ImageCaptureError("decode_failed", "This browser cannot read that photo format."),
        );
      element.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** The real canvas-backed environment. The only DOM-touching code in this file. */
export function browserCompressionEnvironment(): CompressionEnvironment {
  return {
    decode: decodeInBrowser,
    createCanvas(width, height) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new ImageCaptureError("encode_failed", "We could not process that photo.");
      }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";

      return {
        draw(image, targetWidth, targetHeight) {
          // `DrawableImage` is structural so the ladder above can be tested with
          // a plain object; here the value really is an ImageBitmap, an
          // HTMLImageElement or a canvas, all of which are CanvasImageSource.
          // The cast is confined to this adapter.
          context.drawImage(image as unknown as CanvasImageSource, 0, 0, targetWidth, targetHeight);
        },
        encode(quality) {
          return new Promise((resolve) => {
            canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
          });
        },
      };
    },
  };
}

/**
 * doc 33 step 3's `client_sha256`: advisory only. The server recomputes the
 * authoritative hash over its own canonical bytes
 * (src/features/receipts/server/submit.ts), so this value exists purely so the
 * server can log a mismatch between what we uploaded and what landed.
 *
 * Returns undefined rather than throwing when WebCrypto is unavailable (any
 * non-secure origin). An advisory field is never worth failing a scan over.
 */
export async function clientSha256(blob: Blob): Promise<string | undefined> {
  try {
    if (typeof crypto === "undefined" || crypto.subtle === undefined) return undefined;
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return undefined;
  }
}
