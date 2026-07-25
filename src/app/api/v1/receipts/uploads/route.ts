import { randomUUID } from "node:crypto";

import { defineHandler } from "@/lib/api/handler";
import { ApiError, API_ERROR_CODES } from "@/lib/api/errors";
import { RECEIPTS_BUCKET } from "@/features/receipts/server/submit";

// POST /api/v1/receipts/uploads
//
// Step 1 of doc 36 Stage 1's two-step signed upload: hand the client a
// pre-signed PUT URL for a path the SERVER chose, so the image is already in
// the bucket by the time POST /api/v1/receipts runs and the submit request
// stays a small JSON body.
//
// The path is `{auth.uid()}/{uuid}.jpg` and is generated here, never accepted
// from the client (doc 15: "filename regenerated to UUID, never user-controlled
// paths"). A client-supplied name is a path-traversal and overwrite primitive:
// it decides which object the signed URL authorizes a write to, which is the
// whole authorization decision this endpoint makes.

/** Doc 36 API surface table: "Signed PUT URL, 20/min upload limit". */
const UPLOAD_RATE_LIMIT = 20;
const UPLOAD_RATE_LIMIT_WINDOW_SECONDS = 60;

export const POST = defineHandler({
  route: "receipts.uploads",
  requireSession: true,
  rateLimit: { limit: UPLOAD_RATE_LIMIT, windowSeconds: UPLOAD_RATE_LIMIT_WINDOW_SECONDS },
  // Deliberately NOT idempotent. Each call mints a ticket for a fresh path and
  // writes nothing; a client that calls twice has simply wasted a uuid. Doc 13
  // reserves Idempotency-Key for requests whose repetition causes real harm,
  // which is the submit endpoint, not this one.
  handler: async ({ user, supabase }) => {
    const imagePath = `${user.id}/${randomUUID()}.jpg`;

    // The SESSION client, not the service role, on purpose. createSignedUploadUrl
    // requires `insert` on storage.objects, so 0019's owner-prefix policy is
    // evaluated against the caller: even if the path construction above were
    // ever wrong, Postgres would refuse to mint a URL pointing into another
    // consumer's folder. Using the service role here would bypass exactly the
    // fence that makes this endpoint safe.
    const { data, error } = await supabase.storage
      .from(RECEIPTS_BUCKET)
      .createSignedUploadUrl(imagePath);

    if (error !== null || data === null) {
      console.error("[receipts] could not create a signed upload url", error);
      throw new ApiError(
        503,
        API_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
        "Receipt scanning is temporarily unavailable. Please try again shortly.",
      );
    }

    // Returned verbatim from the storage client rather than reconstructed.
    // `token` is what @supabase/supabase-js's uploadToSignedUrl() takes, so
    // omitting it would force the client to parse it back out of the query
    // string. Note the TTL: the Storage API fixes signed upload URLs at 2 hours
    // and exposes no option for it, so doc 36's "TTL 5 min" cannot be honoured
    // on this endpoint. The window is bounded by what it authorizes rather than
    // by time: one PUT, to one server-chosen path, inside the caller's own
    // prefix, with the bucket's 10MB and mime limits still applied.
    return {
      data: {
        upload_url: data.signedUrl,
        image_path: data.path,
        token: data.token,
      },
    };
  },
});
