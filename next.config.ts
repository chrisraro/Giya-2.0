import type { NextConfig } from "next";

import { AVATAR_ACTION_BODY_LIMIT_BYTES } from "./src/features/identity/avatar";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      /**
       * Next's default is 1 MB (`defaultActionBodySizeLimit` in
       * next/dist/build/templates/app-page.js), and anything larger is answered
       * with a 413 BEFORE the action function is entered.
       *
       * `saveConsumerAvatar` carries a File through a Server Action, so the
       * default silently capped avatar uploads at 1 MB - well under the 4-6MB a
       * phone camera actually produces, which is the case the upload path was
       * designed around. The action's own size check and its "larger than 8 MB"
       * copy were unreachable, and the failure was a thrown 413 nothing caught:
       * the controls greyed out and the screen said nothing.
       *
       * Imported rather than written as a literal so the two files cannot drift.
       * src/features/identity/avatar.test.ts asserts this value IS
       * AVATAR_ACTION_BODY_LIMIT_BYTES and that it clears
       * AVATAR_MAX_UPLOAD_BYTES.
       *
       * A number is bytes; a string would be parsed by `bytes`. Bytes are used
       * here so the assertion compares numbers rather than parsing a unit
       * suffix back out of a string.
       */
      bodySizeLimit: AVATAR_ACTION_BODY_LIMIT_BYTES,
    },
  },
};

export default nextConfig;
