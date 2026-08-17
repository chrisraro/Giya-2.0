import { sniffImageFormat } from "@/features/receipts/server/image";

import {
  type BusinessDocumentMimeType,
} from "../documents";

// The byte-level half of the upload fence. It lives in `server/` and not beside
// the constants in ../documents.ts for a concrete reason: `sniffImageFormat`
// carries a `server-only` import, and the registration wizard is a client
// component that needs the accept list and the size cap. Splitting keeps those
// constants importable from the browser while the sniffing stays where it can
// never ship to one.

/** `%PDF-`, the five bytes every PDF starts with. */
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d];

/**
 * What the bytes ACTUALLY are, or null when they are not one of the three
 * formats this bucket accepts.
 *
 * THIS IS THE FENCE THAT SEES BYTES. 0079's `allowed_mime_types` checks the
 * DECLARED Content-Type, which is whatever the browser put on the multipart
 * part, so it is a second fence and not the truth. Doc 15 requires
 * "content-type + magic-byte sniffing"; this is the half that counts, and it is
 * what stops SVG markup being stored under an `image/png` label and later
 * opened as a document in an admin reviewer's browser tab.
 *
 * The JPEG and PNG signatures are NOT restated here. `sniffImageFormat` already
 * owns that table for receipts and avatars, and two copies of a signature table
 * are two things that drift apart. What this adds is PDF, which the image
 * sniffer has no reason to know about, and the NARROWING that matters: the
 * image sniffer also recognises WebP, which the avatars and receipts buckets
 * take and this one does not. Passing that through would produce an upload the
 * bucket then rejects for a reason the merchant cannot see.
 *
 * Signatures only: this deliberately does not decode, so it stays cheap and
 * cannot itself be the thing a malicious file attacks.
 */
export function sniffDocumentFormat(bytes: Uint8Array): BusinessDocumentMimeType | null {
  if (bytes.length >= PDF_SIGNATURE.length) {
    if (PDF_SIGNATURE.every((byte, index) => bytes[index] === byte)) return "application/pdf";
  }

  switch (sniffImageFormat(bytes)) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    default:
      // `webp` lands here on purpose, alongside "not an image at all".
      return null;
  }
}
