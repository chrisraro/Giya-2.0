import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

import { AVATAR_ACTION_BODY_LIMIT_BYTES } from "./src/features/identity/avatar";

/** Just the variables these two helpers read. Narrower than `NodeJS.ProcessEnv`,
 *  which Next augments to require `NODE_ENV` and so cannot be built literally. */
export type BuildEnv = {
  readonly GIYA_BUILD_ID?: string | undefined;
  readonly VERCEL_GIT_COMMIT_SHA?: string | undefined;
  readonly GITHUB_SHA?: string | undefined;
  readonly NODE_ENV?: string | undefined;
};

/** What a local build uses when nothing supplies a real id. */
export const PLACEHOLDER_BUILD_ID = "dev";

/**
 * The build id every service worker cache name embeds (doc 41 section 7 step 1).
 *
 * A deploy must change this, because it is the entire mechanism by which a
 * stale shell cannot survive one: the new worker's cache names do not collide
 * with the old worker's, and on `activate` it deletes everything carrying a
 * different id. It is ALSO the precache revision of `/offline` and
 * `/manifest.webmanifest`, so a frozen id does not merely stop caches rotating
 * - it pins the offline document at whatever the first deploy shipped, forever.
 *
 * DELIBERATELY TOTAL: it resolves or falls back, and never throws. This runs at
 * module load, and next.config.ts is loaded by `next start` as well as by
 * `next build`. The id is baked into the emitted worker at build time, so once
 * a build has a real one the running server never needs it - and refusing to
 * boot a production server over a cache-versioning variable would take down a
 * deploy that compiled perfectly well yesterday. The check that has teeth is
 * `assertBuildIdIsReal`, called from the build phase only.
 */
export function resolveBuildId(env: BuildEnv): string {
  // `||` not `??`: a CI step that exports the variable without a value is the
  // common way this goes wrong, and an empty string is not a build id.
  const fromEnv = env.GIYA_BUILD_ID || env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA;
  return fromEnv || PLACEHOLDER_BUILD_ID;
}

/**
 * Fails a production BUILD that would bake the placeholder into the worker.
 *
 * Called from the webpack hook, which is the phase that does the baking and
 * the only phase where the answer can still be acted on. `isProductionBuild`
 * comes from Next's own `dev` flag rather than from NODE_ENV, because that flag
 * is what actually distinguishes the compilation that emits `public/sw.js`.
 *
 * Loud on purpose: `cache-names.ts` already refuses an EMPTY id, and "dev" is
 * the shape that slips past it, reads fine in a build log, and is wrong on
 * every deploy after the first. Vercel and GitHub Actions both provide a commit
 * SHA unasked, so this only fires on a pipeline that has neither and has not
 * set `GIYA_BUILD_ID`.
 */
export function assertBuildIdIsReal(buildId: string, isProductionBuild: boolean): void {
  if (!isProductionBuild) return;
  if (buildId !== PLACEHOLDER_BUILD_ID) return;

  throw new Error(
    "Service worker build id missing. Set GIYA_BUILD_ID (or let CI provide " +
      "VERCEL_GIT_COMMIT_SHA / GITHUB_SHA). Without it every deploy shares one " +
      "cache generation and the precached /offline document never updates.",
  );
}

const BUILD_ID = resolveBuildId(process.env);

/**
 * Whether this process should build and wire up the service worker at all.
 *
 * False in development, and that is the whole point: @serwist/next's wrapper
 * always adds a `webpack` key, and Next 16 refuses to run Turbopack when it
 * finds one. The worker is disabled in dev regardless, so applying the wrapper
 * there buys nothing and costs every HMR reload of every working day. Skipping
 * it entirely - rather than passing `disable: true`, which still leaves the
 * webpack key behind - is what gives `next dev` its Turbopack back.
 */
export function shouldEnableServiceWorker(env: BuildEnv): boolean {
  return env.NODE_ENV !== "development";
}

const SERVICE_WORKER_ENABLED = shouldEnableServiceWorker(process.env);

/**
 * Doc 41 section 1's precache set: everything in `public/`, plus the two
 * GENERATED routes a glob can never see - `/offline` and
 * `/manifest.webmanifest`.
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
 * hook that comes first.
 *
 * `/offline` and `/manifest.webmanifest` are rendered routes rather than files
 * on disk, so nothing precaches them automatically. Without the first, the
 * navigation fallback in src/app/sw.ts has nothing to fall back TO - and
 * Serwist's `fallbacks` option expects its entries to be precached already.
 *
 * TOTAL BY CONSTRUCTION: a missing or unreadable `public/` yields the two
 * generated entries rather than throwing. That matters because this runs at
 * MODULE LOAD, and next.config.ts is loaded by `next start` as well as by
 * `next build` - a throw here is not a failed build, it is a server that cannot
 * boot, which reads as every dynamically rendered page 500ing while the
 * prerendered ones keep serving from the CDN.
 *
 * The claim above is guaranteed by the `catch` at the end of this function and
 * by NOTHING ELSE - not by the `public/` directory happening to exist. The
 * previous version of this comment offered "this module is imported by
 * next.config.test.ts, which is where its output is pinned" as its evidence.
 * Those tests run with `cwd` at the repo root, where `public/` always exists,
 * which is the one environment in which the failure being claimed against
 * cannot occur. The test that actually holds this line is
 * `precacheEntries with no public/ directory` in next.config.test.ts, which
 * points `baseDir` at an empty temp directory; delete the `catch` and it fails.
 *
 * @param baseDir the directory `public/` is resolved against. Parameterised
 *   solely so that test can supply a directory with no `public/` in it -
 *   nothing in the app ever passes it.
 */
export function precacheEntries(baseDir: string = process.cwd()): { url: string; revision: string }[] {
  const publicDir = join(baseDir, "public");

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

  // Rendered routes, not files. Keyed to the build id because that is the only
  // revision either of them has.
  const generated = [
    { url: "/offline", revision: BUILD_ID },
    { url: "/manifest.webmanifest", revision: BUILD_ID },
  ];

  // THE GUARD. A build-time asset list is not worth a boot-time crash: with no
  // readable `public/` the worker precaches the two generated routes and
  // nothing else, which degrades the offline shell rather than the server.
  // Covers readdirSync's ENOENT/EACCES on the directory and readFileSync's on
  // any file inside it - a file deleted between the walk and the hash is the
  // same class of problem and gets the same answer.
  try {
    return [...walk(publicDir, ""), ...generated];
  } catch {
    return generated;
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
  // Omitted entirely in development. A `webpack` key is what makes Next 16
  // refuse to run Turbopack, and in dev this hook has nothing to do: the only
  // thing it feeds is a service worker that is not built there.
  ...(SERVICE_WORKER_ENABLED ? { webpack: defineBuildConstants } : {}),
};

/** Only the sliver of webpack this hook touches. `webpack` is not a direct
 *  dependency - Next hands its own copy to the hook - so its types are not
 *  resolvable here and are described structurally instead. */
type WebpackContext = {
  readonly webpack: {
    readonly DefinePlugin: new (definitions: Record<string, string>) => unknown;
  };
  /** Next's own flag for "this is a dev compilation". */
  readonly dev: boolean;
};

/**
 * Substituted into src/app/sw.ts. The service worker is built by a webpack
 * CHILD compilation, which inherits the parent's plugin taps, so a DefinePlugin
 * registered here reaches it.
 *
 * This is also where the build id is checked, because this is the phase that
 * bakes it in - see assertBuildIdIsReal. Exported so next.config.test.ts can
 * prove the check fires here and NOT at module load.
 */
export function defineBuildConstants(config: { plugins?: unknown[] }, { webpack, dev }: WebpackContext) {
  assertBuildIdIsReal(BUILD_ID, !dev);

  config.plugins ??= [];
  config.plugins.push(
    new webpack.DefinePlugin({
      __GIYA_BUILD_ID__: JSON.stringify(BUILD_ID),
      // src/lib/pwa/buckets.ts reads this to decide whose storage origin is
      // cacheable.
      //
      // BELT AND BRACES, NOT LOAD-BEARING. Next inlines NEXT_PUBLIC_* into the
      // service worker's child compilation on its own - measured: removing this
      // line and rebuilding still emits the origin as a string literal in
      // public/sw.js, with no bare `process.env` reference left behind. It is
      // kept because the substitution the security boundary depends on should
      // be visible in this file rather than inferred from framework behaviour,
      // and because `?? ""` pins the unset case to an empty string, which is
      // what makes the matcher fail closed.
      "process.env.NEXT_PUBLIC_SUPABASE_URL": JSON.stringify(
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      ),
    }),
  );
  return config;
}

/**
 * Built ONLY when the wrapper is actually going to be applied.
 *
 * `additionalPrecacheEntries: precacheEntries()` is an ARGUMENT, so it is
 * evaluated wherever this expression is - it is not gated by `disable`, which
 * is merely an option the plugin reads later. Left unconditional at module
 * scope it walked and md5'd every file in `public/` on every config load,
 * including in development, where the wrapper below is then thrown away
 * unused. Now the walk happens only on the path that consumes its output.
 *
 * WHAT THIS DOES NOT DO: it does not confine the walk to `next build`.
 * `SERVICE_WORKER_ENABLED` separates development from everything else, not a
 * build from a running server, so `next start` still pays for it once at boot.
 * The obvious alternative - gating on `process.env.NEXT_PHASE` - is WRONG here:
 * Next sets that variable in next/dist/build/index.js only after the config has
 * been loaded and the compilation has run, so a build would see it unset and
 * silently ship a precache manifest containing nothing from `public/`. A
 * phase-function config export (`export default (phase) => ...`) would work,
 * but changes the shape of this module's default export, which
 * next.config.test.ts drives directly. The walk being cheap and, per the guard
 * in precacheEntries, unable to throw, neither is worth it.
 */
const withSerwist = SERVICE_WORKER_ENABLED
  ? withSerwistInit({
      swSrc: "src/app/sw.ts",
      swDest: "public/sw.js",
      // The worker is registered from the consumer layout only (doc 41's
      // preamble: the business and admin portals are excluded from SW scope).
      // Serwist's own auto-registration runs on every app-router page, which is
      // precisely the thing that must not happen.
      register: false,
      // Serwist would otherwise reload the page the moment connectivity
      // returns. Doc 41 section 9 says offline actions never surprise the user,
      // and a reload mid-scan discards a capture.
      reloadOnOnline: false,
      // Constantly false on this branch, which is only reached when
      // SERVICE_WORKER_ENABLED is true. Kept because it is the plugin's own
      // switch and stating it is cheaper than making a reader derive it; the
      // thing that actually keeps the worker out of development is that this
      // whole wrapper is never built there.
      disable: !SERVICE_WORKER_ENABLED,
      // Everything in public/, plus /offline and /manifest.webmanifest.
      // Supplying this replaces the plugin's own glob of public/ - see
      // precacheEntries() for why that glob cannot be left in place, and why a
      // manifestTransform cannot repair it.
      additionalPrecacheEntries: precacheEntries(),
    })
  : null;

// In development this is the bare config, with no `webpack` key, which is what
// lets `next dev` run on Turbopack. `next build` runs with `--webpack` because
// @serwist/next has no Turbopack support - see package.json.
export default withSerwist === null ? nextConfig : withSerwist(nextConfig);
