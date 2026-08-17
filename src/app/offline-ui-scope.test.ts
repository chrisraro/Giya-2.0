import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

// WHERE THE OFFLINE UX IS ALLOWED TO APPEAR.
//
// Doc 41 section 9 asks for ONE global offline pill: "individual screens never
// invent their own banners except the staleness banner (section 4) and the
// outbox card (section 3)". Doc 41's preamble excludes app/(business) and
// app/(admin) from the offline story altogether.
//
// The portal rule is not about caching - the service worker's scope is "/" and
// the thing that actually keeps portal documents out of Cache Storage is the
// PORTAL_PATH clause in src/lib/pwa/runtime-caching.ts, proved there. This is
// about what the UI CLAIMS. A merchant on a dead connection is looking at a
// redemption they must not validate and a review queue they must not clear;
// an "offline" chip and an install nudge are affordances of a surface that
// keeps working offline, and neither portal does. There is nothing cached for
// them to fall back to, so the honest portal behaviour is the browser's own
// failure, not a Giya pill implying otherwise.
//
// WHAT THIS FILE PROVES, AND WHAT IT DOES NOT.
//
// Every assertion here is a source-text scan, and a source-text scan proves
// exactly one thing: these identifiers are not written in those files. That is
// the right shape for a NEGATIVE claim - "no portal file mounts this" is a
// statement about the whole tree, and there is no tree to walk for a file that
// is supposed not to exist.
//
// It does NOT prove the positive. `.includes("<OfflineBanner")` would be just
// as satisfied by a commented-out mount, so the fact that the consumer layout
// really renders one is proved by identity in
// src/app/(consumer)/layout.test.tsx, which walks the element tree the layout
// returns. The uniqueness check below is the one place this file makes a
// positive-sounding claim, and it claims only that the mount is written in
// exactly one file - not that it works.

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

const CONSUMER_LAYOUT = join("src", "app", "(consumer)", "layout.tsx");
const ROOT_LAYOUT = join("src", "app", "layout.tsx");

/** The mounts that make a surface look offline-capable. */
const OFFLINE_UX_MOUNTS = ["<OfflineBanner", "<InstallPrompt"] as const;

/** Vocabulary no portal file has any business touching. */
const OFFLINE_UX_IDENTIFIERS = [
  "OfflineBanner",
  "InstallPrompt",
  "useOnlineStatus",
  "beforeinstallprompt",
] as const;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC).map((file) => ({
  path: relative(ROOT, file),
  text: readFileSync(file, "utf8"),
}));

describe("the offline UX is a consumer-only surface", () => {
  it.each(OFFLINE_UX_MOUNTS)("CRITICAL: %s is mounted in exactly one place, the consumer layout", (mount) => {
    const mounts = FILES.filter((file) => file.text.includes(mount)).map((file) => file.path);
    expect(mounts).toEqual([CONSUMER_LAYOUT]);
  });

  it("CRITICAL: no file under (business) or (admin) carries any offline affordance", () => {
    // Stated separately from the uniqueness checks above because it is the rule
    // doc 41 actually writes down, and a future refactor that legitimately adds
    // a second consumer mount must still leave this true.
    const portal = FILES.filter(
      (file) =>
        file.path.includes(`${sep}(business)${sep}`) || file.path.includes(`${sep}(admin)${sep}`),
    );
    expect(portal.length).toBeGreaterThan(0);

    for (const file of portal) {
      for (const identifier of OFFLINE_UX_IDENTIFIERS) {
        expect(file.text, `${file.path} mentions ${identifier}`).not.toContain(identifier);
      }
    }
  });

  it("CRITICAL: the root layout mounts neither, which would put both on every surface", () => {
    // The root layout wraps the marketing site, the auth screens, the business
    // portal and the admin portal alike. Mounting here would silently undo
    // everything above, and would look like a tidy-up while doing it.
    const root = FILES.find((file) => file.path === ROOT_LAYOUT);
    expect(root).toBeDefined();

    for (const mount of OFFLINE_UX_MOUNTS) {
      expect(root?.text, `root layout mounts ${mount}`).not.toContain(mount);
    }
  });

  it("CRITICAL: nothing outside the install prompt itself touches beforeinstallprompt", () => {
    // Doc 41: "Never prompt cold." A second listener anywhere would either
    // race this one for the event or fail to preventDefault it, which is how
    // Chrome's own install bar reappears at a moment nobody chose.
    // The LISTENER, not the word: the decision module names the event in its
    // prose and has every right to.
    const owners = FILES.filter((file) =>
      file.text.includes('addEventListener("beforeinstallprompt"'),
    ).map((file) => file.path);
    expect(owners).toEqual([join("src", "components", "pwa", "install-prompt.tsx")]);
  });

  it("keeps the offline pill a client component", () => {
    // `useOnlineStatus` is `useSyncExternalStore` over window events. Without
    // the directive the consumer layout - a server component - would fail to
    // build rather than fail at runtime, but stating it here says why the
    // directive is load-bearing rather than habitual.
    const banner = FILES.find(
      (file) => file.path === join("src", "components", "pwa", "offline-banner.tsx"),
    );
    expect(banner?.text.startsWith('"use client"')).toBe(true);
  });
});
