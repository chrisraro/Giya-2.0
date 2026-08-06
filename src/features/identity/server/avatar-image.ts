import "server-only";

import sharp from "sharp";

import { sniffImageFormat } from "@/features/receipts/server/image";

// The pixel work for the avatar pipeline. Nothing here touches the database,
// storage or a request - the same split image.ts uses for receipts, so the
// action can be unit-tested against a fake of this module while the re-encode
// itself is tested against real bytes produced by sharp.
//
// THIS FILE IS WHAT MAKES THE PUBLIC BUCKET DEFENSIBLE. 0064 publishes avatar
// objects to a CDN with no signature, and a photo straight off a phone camera
// carries an EXIF GPS tag. Publishing the file the consumer picked would publish
// their coordinates; publishing the output of this function publishes decoded
// pixels and nothing else. If this step is ever removed, the bucket has to go
// private in the same change.
//
// `sniffImageFormat` is imported from the receipts module rather than
// reimplemented. It is a pure magic-byte reader with no receipts semantics in
// it, and the alternative is two copies of the same signature table drifting
// apart - the exact failure mode a shared constant exists to prevent. The
// declared Content-Type is attacker-controlled (it is whatever the browser put
// on the multipart part) and the bucket's allowed_mime_types check trusts
// exactly that header, so the sniff is the half that counts.
export { sniffImageFormat };

/**
 * The stored avatar is a square. The profile header renders it at 64 CSS pixels
 * (`size-16`) inside a circle; 512 gives a 4x buffer for a retina render and for
 * any larger surface a later slice adds, and still lands in the tens of
 * kilobytes. Anything bigger would be bytes nobody ever sees.
 */
export const AVATAR_CANONICAL_EDGE = 512;

/**
 * Above the receipts re-encode's 85 would be wasted on a photograph that is
 * about to be drawn inside a 64px circle; below about 80 shows on skin tones,
 * which is most of what an avatar is.
 */
export const AVATAR_JPEG_QUALITY = 82;

export type CanonicalizeAvatarImage = (bytes: Uint8Array) => Promise<Uint8Array>;

/**
 * Re-encode to a square canonical JPEG.
 *
 * `.rotate()` with no argument applies the EXIF orientation tag and then lets it
 * be dropped, so the stored pixels are upright once the tag is gone. Order
 * matters: sharp writes no metadata unless `.withMetadata()` is called, so
 * rotating first is what keeps a phone photo from being stored sideways.
 * NOTHING HERE MAY EVER CALL `.withMetadata()` - that single call would
 * re-attach the EXIF block this function exists to remove, and the bucket is
 * public.
 *
 * `fit: "cover"` rather than "inside": the avatar is drawn in a circle, so a
 * letterboxed portrait would render as a face between two bars. Cover crops to
 * the centre, which is where a person puts their face.
 */
export const canonicalizeAvatarImage: CanonicalizeAvatarImage = async (bytes) => {
  const jpeg = await sharp(Buffer.from(bytes), { failOn: "error" })
    .rotate()
    .resize(AVATAR_CANONICAL_EDGE, AVATAR_CANONICAL_EDGE, {
      fit: "cover",
      position: "centre",
      withoutEnlargement: false,
    })
    .jpeg({ quality: AVATAR_JPEG_QUALITY })
    .toBuffer();

  return new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
};
