import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Every link in the app's two persistent navigations must land on a route
// that actually exists. The audit that prompted this found the opposite
// problem (real routes with no link), but the same wiring can rot the other
// way, and a nav item pointing at a 404 is the most visible failure the shell
// can have. So rather than asserting a hard-coded list of hrefs - which would
// only ever restate the component - this reads the App Router's real page
// inventory off disk and resolves each rendered href against it.

vi.mock("next/navigation", () => ({ usePathname: () => "/home" }));

const { BottomNav } = await import("./shell/bottom-nav");
const { Sidebar } = await import("./business/sidebar");

const APP_DIR = join(process.cwd(), "src", "app");

/**
 * Every route pattern the App Router serves, as segment arrays.
 *
 * Route GROUPS - `(consumer)`, `(auth)`, `(business)`, `(portal)` - are
 * organisational only and contribute no URL segment, so they are dropped.
 * Dynamic segments keep their brackets and are matched positionally below.
 */
function collectRoutePatterns(dir: string, out: string[][] = []): string[][] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRoutePatterns(full, out);
      continue;
    }
    if (entry.name !== "page.tsx" && entry.name !== "page.ts") continue;

    const segments = relative(APP_DIR, dir)
      .split(sep)
      .filter((segment) => segment.length > 0 && !segment.startsWith("("));
    out.push(segments);
  }
  return out;
}

const ROUTE_PATTERNS = collectRoutePatterns(APP_DIR);

function isDynamic(segment: string): boolean {
  return segment.startsWith("[") && segment.endsWith("]");
}

/** Whether `href` resolves to a real page route. */
function resolves(href: string): boolean {
  const path = href.split("?")[0]?.split("#")[0] ?? "";
  const wanted = path.split("/").filter((segment) => segment.length > 0);

  return ROUTE_PATTERNS.some((pattern) => {
    if (pattern.length !== wanted.length) return false;
    return pattern.every((segment, index) => isDynamic(segment) || segment === wanted[index]);
  });
}

function renderedHrefs(): string[] {
  return screen
    .getAllByRole("link")
    .map((link) => link.getAttribute("href") ?? "")
    .filter((href) => href.startsWith("/"));
}

describe("route inventory helper", () => {
  it("finds the app's real routes and rejects invented ones", () => {
    // Guards the test itself: a collector that silently returned [] would make
    // every assertion below vacuous, and one that kept route-group segments
    // would fail every real href.
    expect(ROUTE_PATTERNS.length).toBeGreaterThan(10);
    expect(resolves("/home")).toBe(true);
    expect(resolves("/business/dashboard")).toBe(true);
    expect(resolves("/b/kape-diaria")).toBe(true); // dynamic [slug]
    expect(resolves("/definitely-not-a-route")).toBe(false);
    expect(resolves("/home/nested")).toBe(false);
  });
});

describe("BottomNav destinations", () => {
  it("every link resolves to a real route", () => {
    render(<BottomNav />);

    const hrefs = renderedHrefs();
    expect(hrefs).toEqual(
      expect.arrayContaining(["/home", "/wallet", "/rewards", "/profile", "/scan"]),
    );
    for (const href of hrefs) {
      expect(resolves(href), `bottom nav href ${href} has no route`).toBe(true);
    }
  });
});

describe("business Sidebar destinations", () => {
  it("every link resolves to a real route", () => {
    render(<Sidebar mobileOpen={false} onMobileClose={() => {}} />);

    const hrefs = renderedHrefs();
    // The full portal rail, so a removed page cannot quietly leave its nav
    // item behind.
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/business/dashboard",
        "/business/redeem",
        "/business/receipts",
        "/business/campaigns",
        "/business/menu",
        "/business/customers",
        "/business/rewards",
        "/business/settings",
      ]),
    );
    for (const href of hrefs) {
      expect(resolves(href), `sidebar href ${href} has no route`).toBe(true);
    }
  });
});
