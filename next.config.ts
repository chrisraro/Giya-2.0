import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

import { AVATAR_ACTION_BODY_LIMIT_BYTES } from "./src/features/identity/avatar";

/**
 * The build id every service worker cache name embeds (doc 41 section 7 step 1).
 *
 * A deploy must change this, because that is the entire mechanism by which a
 * stale shell cannot survive one: the new worker's cache names do not collide
 * with the old worker's, and on `activate` it deletes everything carrying a
 * different id. CI is expected to set `GIYA_BUILD_ID`; Vercel and GitHub
 * Actions both hand us the commit SHA without being asked.
 *
 * The "dev" fallback is for local `next build`, where nothing is deployed and a
 * stable id is what you want. If a real deploy ever runs with none of these set,
 * every deploy shares one id and the caches stop rotating - see the note in
 * src/lib/pwa/cache-names.ts.
 */
const BUILD_ID =
  process.env.GIYA_BUILD_ID ??
  process.env.VERCEL_GIT_COMMIT_SHA ??
  process.env.GITHUB_SHA ??
  "dev";

/**
 * The precache entries for everything in `public/`, plus the `/offline`
 * document.
 *
 * WHY THIS IS COMPUTED HERE RATHER THAN LEFT TO @serwist/next.
 *
 * The plugin globs `public/` itself and joins each result with the PLATFORM
 * path separator, so a build on Windows emits precache URLs like
 * `/brand\icon-192.png`. One 404 in a precache list fails the whole `install`
 * event, which means the service worker never installs at all - so the PWA
 * would be untestable on a Windows dev machine while CI on Linux looked fine.
 * `manifestTransforms` cannot fix it: @serwist/build appends the plugin's
 * entries as the LAST transform, after ours. Supplying the list is the only
 * hook that comes first, and it also happens to be where `/offline` belongs.
 *
 * `/offline` is not in `public/` and is not a build asset - it is a rendered
 * document - so nothing would precache it automatically, and the navigation
 * fallback in src/app/sw.ts would have nothing to fall back TO.
 *
 * Never throws: this module is imported by src/features/identity/avatar.test.ts.
 */
function precacheEntries(): { url: string; revision: string }[] {
  const publicDir = join(process.cwd(), "public");

  // The compiled worker and its sourcemap live in public/ after a build. A
  // service worker that precaches itself is a worker that can never be
  // replaced.
  const skip = /^(sw\.js(\.map)?|swe-worker-.*)$/;

  function walk(dir: string, prefix: string): { url: string; revision: string }[] {
    const out: { url: string; revision: string }[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.test(entry.name)) continue;
      const full = join(dir, entry.name);
      // Forward slashes, always: this is a URL, not a path.
      const url = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) out.push(...walk(full, url));
      else {
        out.push({
          url,
          revision: createHash("md5").update(readFileSync(full)).digest("hex"),
        });
      }
    }
    return out;
  }

  try {
    return [...walk(publicDir, ""), { url: "/offline", revision: BUILD_ID }];
  } catch {
    return [{ url: "/offline", revision: BUILD_ID }];
  }
}

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
       * AVATAR_MAX_UPLOAD_BYTES. That test reads the DEFAULT EXPORT of this
       * file, which is now the Serwist-wrapped config - so the wrapper must
       * carry `experimental` through untouched, and the test is what proves it.
       *
       * A number is bytes; a string would be parsed by `bytes`. Bytes are used
       * here so the assertion compares numbers rather than parsing a unit
       * suffix back out of a string.
       */
      bodySizeLimit: AVATAR_ACTION_BODY_LIMIT_BYTES,
    },
  },
  webpack(config, { webpack }) {
    // Substituted into src/app/sw.ts. The service worker is built by a webpack
    // CHILD compilation, which inherits the parent's plugin taps, so a
    // DefinePlugin registered here reaches it.
    config.plugins.push(
      new webpack.DefinePlugin({
        __GIYA_BUILD_ID__: JSON.stringify(BUILD_ID),
        // src/lib/pwa/buckets.ts reads this to decide whose storage origin is
        // cacheable. Next inlines NEXT_PUBLIC_* into the app bundle, but the
        // worker is a separate child compilation and this is the substitution
        // that is verifiable rather than assumed. Empty string when unset, so
        // the matcher fails closed and caches nothing rather than caching
        // anyone's bytes.
        "process.env.NEXT_PUBLIC_SUPABASE_URL": JSON.stringify(
          process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
        ),
      }),
    );
    return config;
  },
};

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  // The worker is registered from the consumer layout only (doc 41's preamble:
  // the business and admin portals are excluded from SW scope). Serwist's own
  // auto-registration runs on every app-router page, which is precisely the
  // thing that must not happen.
  register: false,
  // Serwist would otherwise reload the page the moment connectivity returns.
  // Doc 41 section 9 says offline actions never surprise the user, and a reload
  // mid-scan discards a capture.
  reloadOnOnline: false,
  disable: process.env.NODE_ENV === "development",
  // Everything in public/, plus the /offline document. Supplying this replaces
  // the plugin's own glob of public/ - see precacheEntries() for why that glob
  // cannot be left in place, and why a manifestTransform cannot repair it.
  additionalPrecacheEntries: precacheEntries(),
});

export default withSerwist(nextConfig);
