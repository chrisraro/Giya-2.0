import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import nextConfig, {
  PLACEHOLDER_BUILD_ID,
  assertBuildIdIsReal,
  precacheEntries,
  resolveBuildId,
  shouldEnableServiceWorker,
} from "./next.config";

// THE BUILD WIRING FOR THE SERVICE WORKER.
//
// This file exists because the previous version of this work had none, and two
// mutations of next.config.ts survived the entire suite: dropping `/offline`
// from the precache list, and dropping the hand-rolled list altogether (which
// restores a Windows-only bug where every precache URL comes back with
// backslashes, 404s, and fails the `install` event - taking the whole worker
// down). The only evidence either worked was a human reading a build artifact.
//
// `precacheEntries` is a pure function over the filesystem, so none of that
// needs a build to check.

const ROOT = process.cwd();

describe("resolveBuildId", () => {
  // Doc 41 section 7 step 1. The id is what makes every cache name unique per
  // deploy AND what versions the precached `/offline` document, so a frozen id
  // does not just stop caches rotating - it pins the offline page forever.

  it("prefers an explicit GIYA_BUILD_ID", () => {
    expect(
      resolveBuildId({ GIYA_BUILD_ID: "abc123", VERCEL_GIT_COMMIT_SHA: "zzz" }),
    ).toBe("abc123");
  });

  it("falls back to the CI-provided commit SHAs, Vercel before GitHub", () => {
    expect(resolveBuildId({ VERCEL_GIT_COMMIT_SHA: "vsha", GITHUB_SHA: "gsha" })).toBe("vsha");
    expect(resolveBuildId({ GITHUB_SHA: "gsha" })).toBe("gsha");
  });

  it("treats an empty variable as absent", () => {
    // A CI step that exports the variable without a value is the common way
    // this goes wrong, and `??` would happily return "".
    expect(resolveBuildId({ GIYA_BUILD_ID: "", GITHUB_SHA: "gsha" })).toBe("gsha");
  });

  it("falls back to a stable placeholder rather than failing", () => {
    expect(resolveBuildId({ NODE_ENV: "development" })).toBe(PLACEHOLDER_BUILD_ID);
    expect(resolveBuildId({})).toBe(PLACEHOLDER_BUILD_ID);
  });

  it("CRITICAL: resolving never throws, not even in production", () => {
    // This function runs at MODULE LOAD, and next.config.ts is loaded by
    // `next start` as well as by `next build`. Throwing here would take down a
    // production server over a variable that only matters while the worker is
    // being compiled - a self-hosted deploy that built fine yesterday would
    // refuse to boot today. The check belongs in the build phase, and that is
    // where assertBuildIdIsReal puts it.
    expect(() => resolveBuildId({ NODE_ENV: "production" })).not.toThrow();
    expect(resolveBuildId({ NODE_ENV: "production" })).toBe(PLACEHOLDER_BUILD_ID);
  });
});

describe("assertBuildIdIsReal", () => {
  it("CRITICAL: fails a production build that would bake in the placeholder", () => {
    // Failing the build is the only outcome that cannot ship silently. With
    // "dev" baked in, every deploy shares one id: caches never rotate, and the
    // precached /offline document is frozen at whatever the first deploy had.
    expect(() => assertBuildIdIsReal(PLACEHOLDER_BUILD_ID, true)).toThrow(/GIYA_BUILD_ID/);
  });

  it("passes a production build that has a real id", () => {
    expect(() => assertBuildIdIsReal("5aaf2ff", true)).not.toThrow();
  });

  it("CRITICAL: says nothing outside a production build", () => {
    // The placeholder is the correct, intended value for a local build.
    expect(() => assertBuildIdIsReal(PLACEHOLDER_BUILD_ID, false)).not.toThrow();
  });
});

describe("precacheEntries", () => {
  const entries = precacheEntries();
  const urls = entries.map((entry) => entry.url);

  it("CRITICAL: no URL contains a backslash", () => {
    // @serwist/next globs public/ and joins with the PLATFORM separator, so its
    // own list comes back as `/brand\icon-192.png` on Windows. One 404 in a
    // precache list fails the whole `install` event, so the worker never
    // installs at all - invisible on Linux CI, fatal on the machine this is
    // developed on.
    expect(urls.filter((url) => url.includes("\\"))).toEqual([]);
  });

  it("CRITICAL: precaches /offline, which no glob would ever find", () => {
    // It is a rendered document, not a file in public/ and not a build asset.
    // Without it the navigation fallback in src/app/sw.ts has nothing to fall
    // back TO, and Serwist's `fallbacks` option requires its entries to be
    // precached already.
    expect(urls).toContain("/offline");
  });

  it("CRITICAL: precaches /manifest.webmanifest, which is also generated", () => {
    // Doc 41 section 1 lists the manifest in the precache set. Same situation
    // as /offline: app/manifest.ts is a route, not a file on disk.
    expect(urls).toContain("/manifest.webmanifest");
  });

  it("versions both generated routes with the build id", () => {
    const offline = entries.find((entry) => entry.url === "/offline");
    const manifest = entries.find((entry) => entry.url === "/manifest.webmanifest");
    expect(offline?.revision).toBeTruthy();
    expect(manifest?.revision).toBe(offline?.revision);
  });

  it("CRITICAL: never precaches the worker or its sourcemap", () => {
    // These only exist in public/ AFTER a build, so the files have to be put
    // there for the assertion to mean anything - a checkout with no build
    // output makes this vacuously true and it would pass with the skip list
    // deleted. A worker that precaches itself is a worker that can never be
    // replaced.
    const created: string[] = [];
    for (const name of ["sw.js", "sw.js.map", "swe-worker-abc123.js"]) {
      const path = join(ROOT, "public", name);
      if (!existsSync(path)) {
        writeFileSync(path, "// build output");
        created.push(path);
      }
    }

    try {
      const withBuildOutput = precacheEntries().map((entry) => entry.url);
      expect(withBuildOutput.filter((url) => /sw\.js|swe-worker/.test(url))).toEqual([]);
      // The fixture really was there, so the emptiness above is a refusal
      // rather than an absence.
      expect(created.length).toBeGreaterThan(0);
    } finally {
      for (const path of created) rmSync(path, { force: true });
    }
  });

  it("returns forward-slashed root-relative URLs for nested public files", () => {
    expect(urls).toContain("/brand/icon-192.png");
    expect(urls).toContain("/brand/icon-maskable-512.png");
    for (const url of urls) expect(url.startsWith("/"), url).toBe(true);
  });

  it("CRITICAL: every entry that is a file resolves to a real FILE", () => {
    // The property a 404 in the install event actually violates, asserted
    // directly rather than inferred from the shape of the string.
    //
    // `isFile()`, not `existsSync`: a URL that has collapsed to "/" or to a
    // directory name still "exists" on disk and would sail through an
    // existence check while precaching something the server will never serve
    // as a document. That is not hypothetical - it is exactly what one of the
    // mutants for this file produced.
    const generated = new Set(["/offline", "/manifest.webmanifest"]);
    const files = urls.filter((url) => !generated.has(url));
    expect(files.length).toBeGreaterThan(5);
    for (const url of files) {
      const path = join(ROOT, "public", url);
      expect(existsSync(path), url).toBe(true);
      expect(statSync(path).isFile(), url).toBe(true);
    }
  });

  it("gives every entry a content revision, so a changed file busts its cache", () => {
    for (const entry of entries) {
      expect(entry.revision, entry.url).toMatch(/^[0-9a-z]+$/);
    }
  });
});

describe("the build-id check fires during a BUILD, not at config load", () => {
  // The narrowing this block exists to hold. next.config.ts is loaded by
  // `next start` as well as by `next build`, and the id is baked into the
  // emitted worker at build time - so once a build has a real id, the running
  // server never needs one. A throw at module load would refuse to boot a
  // production server that built perfectly well.

  class FakeDefinePlugin {
    constructor(readonly definitions: Record<string, string>) {}
  }
  const fakeWebpack = { DefinePlugin: FakeDefinePlugin };

  /**
   * The module as it loads in a production process with no build id at all -
   * which is exactly the `next start` situation this narrowing is about.
   */
  async function loadWithNoBuildId() {
    vi.resetModules();
    vi.stubEnv("GIYA_BUILD_ID", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.stubEnv("GITHUB_SHA", "");
    vi.stubEnv("NODE_ENV", "production");
    return import("./next.config");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("CRITICAL: loading the config with no build id does not throw - the `next start` shape", async () => {
    await expect(loadWithNoBuildId()).resolves.toBeDefined();
  });

  it("CRITICAL: the webpack hook refuses a production build with no build id", async () => {
    const mod = await loadWithNoBuildId();
    expect(() => mod.defineBuildConstants({ plugins: [] }, { webpack: fakeWebpack, dev: false })).toThrow(
      /GIYA_BUILD_ID/,
    );
  });

  it("compiles a local build with the placeholder, and substitutes both constants", async () => {
    const mod = await loadWithNoBuildId();
    const config: { plugins?: unknown[] } = { plugins: [] };

    expect(() => mod.defineBuildConstants(config, { webpack: fakeWebpack, dev: true })).not.toThrow();

    const [plugin] = config.plugins as FakeDefinePlugin[];
    expect(Object.keys(plugin?.definitions ?? {})).toEqual([
      "__GIYA_BUILD_ID__",
      "process.env.NEXT_PUBLIC_SUPABASE_URL",
    ]);
    // src/app/sw.ts reads the first as its cache generation; src/lib/pwa/buckets.ts
    // reads the second to decide whose storage origin may be cached.
    expect(plugin?.definitions.__GIYA_BUILD_ID__).toBe(JSON.stringify(PLACEHOLDER_BUILD_ID));
  });
});

describe("service worker build wiring", () => {
  it("CRITICAL: next.config.ts actually hands the list to Serwist", () => {
    // precacheEntries() being correct is worth nothing if the config stops
    // calling it - and that mutation is invisible to every behavioural test,
    // because it silently restores the plugin's own broken glob.
    const source = readFileSync(join(ROOT, "next.config.ts"), "utf8");
    expect(source).toMatch(/additionalPrecacheEntries:\s*precacheEntries\(\)/);
  });

  it("skips the Serwist wrapper in development, so `next dev` keeps Turbopack", () => {
    // The worker is disabled in development anyway. The only thing the wrapper
    // and its webpack hook do there is force Next off Turbopack, which costs
    // every HMR reload of every day for no benefit at all.
    expect(shouldEnableServiceWorker({ NODE_ENV: "development" })).toBe(false);
    expect(shouldEnableServiceWorker({ NODE_ENV: "production" })).toBe(true);
    expect(shouldEnableServiceWorker({ NODE_ENV: "test" })).toBe(true);
  });

  it("CRITICAL: wrapping preserves the Server Action body limit", () => {
    // src/features/identity/avatar.test.ts owns this contract; restated here
    // because it is THIS file's wrapper that can break it, and a 1 MB cap on
    // avatar uploads was a Critical on an earlier task.
    expect(typeof nextConfig.experimental?.serverActions?.bodySizeLimit).toBe("number");
    expect(nextConfig.webpack).toBeTypeOf("function");
  });
});
