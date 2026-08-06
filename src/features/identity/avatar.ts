// The avatar object-path convention, in one place, so the client form, the
// server action and the storage policies in 0064_avatars_storage.sql are all
// talking about the same object name.
//
// A plain module: no "use server", no "use client", no imports beyond the
// standard library. Both sides import it and nothing crosses the RSC boundary.
//
// avatar.test.ts parses the predicates out of 0064 and asserts the builder below
// satisfies them. That test is the point of this file existing at all: the
// convention is only correct as a RELATIONSHIP between the name we write and the
// segment the policy reads, and a constant on one side proves nothing about the
// other.

/** `storage.buckets.id` created by 0064. */
export const AVATARS_BUCKET = "avatars";

/**
 * The formats an upload may arrive in. Exactly the bucket's
 * `allowed_mime_types`, asserted equal in avatar.test.ts: the form should refuse
 * a format before the round trip that the Storage API would refuse after it.
 */
export const AVATAR_ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type AvatarMimeType = (typeof AVATAR_ACCEPTED_MIME_TYPES)[number];

/**
 * What actually gets STORED. Every upload is re-encoded before it reaches the
 * bucket (see server/avatar-image.ts), so exactly one format is ever written
 * regardless of what came in - which is what lets the filename extension below
 * be a constant rather than something derived from a client-declared type.
 */
export const AVATAR_CANONICAL_MIME_TYPE = "image/jpeg";
export const AVATAR_CANONICAL_EXTENSION = "jpg";

/**
 * The bucket's own `file_size_limit` (2MB), restated so the app can say the same
 * number the Storage API will. This bounds the DIRECT Storage-API path into a
 * caller's own prefix, not what the consumer may pick in the file dialog.
 */
export const AVATAR_BUCKET_MAX_BYTES = 2 * 1024 * 1024;

/**
 * What the server action accepts from the consumer BEFORE re-encoding. Larger
 * than the bucket cap on purpose: a photo straight off a phone camera is
 * routinely 4-6MB, and rejecting it would be rejecting the most common way a
 * person has of choosing a picture of themselves. The re-encode turns it into a
 * 512px JPEG that lands far under the bucket's ceiling.
 */
export const AVATAR_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * THE NUMBER next.config.ts MUST CONFIGURE, and the reason this constant exists
 * at all.
 *
 * Next.js caps a Server Action's request body at 1 MB by default
 * (`defaultActionBodySizeLimit = '1 MB'`, node_modules/next/dist/build/
 * templates/app-page.js) and answers anything larger with a 413 BEFORE the
 * action function is entered. The avatar upload carries a File through a Server
 * Action, so with the default in place every photo between 1 MB and
 * AVATAR_MAX_UPLOAD_BYTES died in the framework: the action's own size check was
 * unreachable, its "larger than 8 MB" copy could never render, and the consumer
 * saw a screen that simply stopped responding.
 *
 * The headroom above AVATAR_MAX_UPLOAD_BYTES is for the ENVELOPE. The limit is
 * measured against the whole multipart action payload - boundaries, headers, the
 * action id - not against the file, so a limit set exactly at the file size
 * would 413 a file that is exactly at the file size.
 *
 * avatar.test.ts asserts next.config.ts's configured value IS this constant, so
 * raising one without the other fails a test rather than production.
 */
export const AVATAR_ACTION_BODY_LIMIT_BYTES = AVATAR_MAX_UPLOAD_BYTES + 1024 * 1024;

/**
 * The copy for a photo past the ceiling, in one place because BOTH sides say it.
 *
 * The form checks the size before it sends anything - a body past the Server
 * Action limit is answered with a 413 by the framework before the action is
 * entered, so a check that only lives server-side produces a message nobody can
 * ever see. The action checks it again for a caller that is not our form.
 * Sharing the sentence keeps the two checks from disagreeing about the number
 * they are both quoting.
 */
export function oversizePhotoMessage(): string {
  const megabytes = Math.floor(AVATAR_MAX_UPLOAD_BYTES / (1024 * 1024));
  return `That photo is larger than ${megabytes} MB. Try a smaller one.`;
}

/**
 * The 1-based path segment that carries the owner's auth uid - the SQL index in
 * `(storage.foldername(name))[1]`. Named rather than inlined so the agreement
 * test can compare it to the number actually written in 0064.
 */
export const AVATAR_OWNER_SEGMENT_INDEX = 1;

/** Folder levels in an object name, i.e. `array_length(foldername(name), 1)`. */
export const AVATAR_FOLDER_DEPTH = 1;

/**
 * A fresh object name for one upload: `{user_id}/{uuid}.jpg`.
 *
 * The uuid is minted HERE and the filename is never derived from anything the
 * consumer supplied. A client-supplied name is a path-traversal and overwrite
 * primitive - it would decide which object a write lands on, which is the whole
 * authorization decision the storage policy makes - and this is the same rule
 * the receipts signed-upload endpoint follows (doc 15: "filename regenerated to
 * UUID, never user-controlled paths").
 *
 * A fresh uuid per upload also means a REPLACE changes the public URL. That is
 * deliberate: the bucket is public and CDN-cached, and reusing one stable name
 * would leave edges serving the face the consumer just replaced.
 */
export function newAvatarObjectPath(userId: string): string {
  return `${userId}/${crypto.randomUUID()}.${AVATAR_CANONICAL_EXTENSION}`;
}

/** `.../storage/v1/object/public/avatars/` - the prefix `getPublicUrl` produces. */
const PUBLIC_URL_MARKER = `/storage/v1/object/public/${AVATARS_BUCKET}/`;

/**
 * The object path inside the bucket, recovered from the public URL stored in
 * `profiles.avatar_url`, or null when the URL is not one of ours.
 *
 * This is what lets replace and remove DELETE the previous object instead of
 * orphaning a public, permanently-fetchable copy of a face the consumer just
 * took down. Null is the safe answer and is returned for anything that is not
 * unambiguously an object in this bucket - an OAuth provider's avatar URL, a
 * receipts path, a bucket-root URL with no object after it. Nothing is ever
 * deleted on a guess.
 */
export function objectPathFromPublicUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  const markerAt = url.indexOf(PUBLIC_URL_MARKER);
  if (markerAt === -1) return null;

  const afterMarker = url.slice(markerAt + PUBLIC_URL_MARKER.length);
  // `getPublicUrl` can append a transform/cache query; the object path is the
  // part before it.
  const path = afterMarker.split("?")[0] ?? "";

  return path.length > 0 ? path : null;
}
