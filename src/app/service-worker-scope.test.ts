import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

// WHICH SURFACES GET A SERVICE WORKER.
//
// Doc 41's preamble: "The business and admin portals (app/(business),
// app/(admin)) are EXCLUDED from SW scope - staff/admin surfaces must never
// serve stale tenant data; the SW registration is scoped to consumer routes
// only."
//
// Two reasons, and they are different reasons. Staleness: a merchant validating
// a redemption or working a review queue is making a decision that must be made
// against the live row, and a NetworkFirst document cache will happily hand
// them yesterday's page when the shop wifi drops. Exposure: a back-office
// terminal is shared by the whole shift, and an admin document sitting in Cache
// Storage outlives the session that fetched it.
//
// WHAT THIS FILE PROVES, AND WHAT IT DOES NOT.
//
// It proves one thing: the registration call happens in exactly one place, and
// that place is the consumer layout. That is worth pinning - it means no
// merchant or admin visit can be the visit that INSTALLS a worker, and it
// fences the two tasks that follow, since T5.2 mounts the offline banner and
// T5.3 the outbox and neither should widen this.
//
// It does NOT prove that portal routes go uncached, and an earlier version of
// this comment claimed it did. Scope is a property of `register(url, {scope})`,
// not of which component called it, and the scope is "/" - it has to be, or the
// `/offline` fallback cannot answer a navigation to a URL we have never
// rendered. Add `clientsClaim` and one consumer page registering puts EVERY
// navigation on the origin through the worker, a merchant's included. The thing
// that actually keeps `/business/*` and `/admin/*` out of the document cache is
// the PORTAL_PATH clause in the pages route matcher, and it is proved where it
// lives: src/lib/pwa/runtime-caching.test.ts, "merchant and admin documents are
// never written to the pages cache".

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

const MOUNT = "<RegisterServiceWorker";
const CONSUMER_LAYOUT = join("src", "app", "(consumer)", "layout.tsx");
const COMPONENT = join("src", "components", "pwa", "register-service-worker.tsx");

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

describe("the service worker is a consumer-only surface", () => {
  it("CRITICAL: is mounted in exactly one place, the consumer layout", () => {
    const mounts = FILES.filter((file) => file.text.includes(MOUNT)).map((file) => file.path);
    expect(mounts).toEqual([CONSUMER_LAYOUT]);
  });

  it("CRITICAL: no file under (business) or (admin) touches service worker registration", () => {
    // Stated separately from the uniqueness check above because it is the rule
    // doc 41 actually writes down, and a future refactor that legitimately adds
    // a second consumer mount must still leave this true.
    const portal = FILES.filter(
      (file) =>
        file.path.includes(`${sep}(business)${sep}`) || file.path.includes(`${sep}(admin)${sep}`),
    );
    expect(portal.length).toBeGreaterThan(0);

    for (const file of portal) {
      expect(file.text, file.path).not.toContain(MOUNT);
      expect(file.text, file.path).not.toContain("serviceWorker");
      expect(file.text, file.path).not.toContain("/sw.js");
    }
  });

  it("CRITICAL: the root layout does not mount it, which would put it on every surface", () => {
    // The root layout wraps the marketing site, the auth screens, the business
    // portal and the admin portal alike. Mounting here would silently undo
    // everything above, and would look like a tidy-up while doing it.
    const root = FILES.find((file) => file.path === join("src", "app", "layout.tsx"));
    expect(root).toBeDefined();
    expect(root?.text).not.toContain(MOUNT);
  });

  it("CRITICAL: Serwist's own auto-registration is off", () => {
    // @serwist/next injects its entry into `main-app`, which every App Router
    // page shares. With `register` left at its default of true it calls
    // register() on EVERY page - business and admin included - and the mount
    // rules above become decoration.
    const config = readFileSync(join(ROOT, "next.config.ts"), "utf8");
    expect(config).toMatch(/register:\s*false/);
  });

  it("keeps the registration decisions out of the component that mounts them", () => {
    // The component is a client component and cannot be imported by a server
    // module; the decisions it acts on are plain functions that can. This is
    // what lets src/lib/pwa/register.test.ts test the update flow at all.
    const component = FILES.find((file) => file.path === COMPONENT);
    expect(component?.text.startsWith('"use client"')).toBe(true);
  });
});
