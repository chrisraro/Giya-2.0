import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// motion/react resolves `prefers-reduced-motion` through its own media-query
// cache, seeded once at module load, so stubbing `window.matchMedia` from a
// test does not reach it - both settings come back identical and a
// reduced-motion assertion built that way passes no matter what the component
// does. Only `useReducedMotion` is replaced; the real `motion` proxy still
// renders, so every other assertion below is against the real library.
const reducedMotion = vi.hoisted(() => ({ value: false }));

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => reducedMotion.value };
});

const { OfflineBanner } = await import("./offline-banner");

// THE OFFLINE PILL, AND THE SENTENCE IT IS ALLOWED TO SAY.
//
// Doc 41 section 9: one global, non-blocking "Offline" pill driven by
// `useOnlineStatus()`; individual screens never invent their own banners.
//
// The copy is the reason most of this file exists. The banner shipped (unmounted)
// with "You are offline. Scanned receipts will be queued in your outbox." - a
// sentence describing T5.3. `src/features/pwa/outbox.ts` has no callers today:
// nothing in the scan or submit flow enqueues anything, so a consumer who read
// that, scanned in a basement, and closed the tab would lose the receipt AND
// have been told we kept it. This project has shipped that defect twice
// (/suspended's "you cannot redeem" while redemption was ungated; the device
// list's "does not sign that browser out" while it did). The assertions below
// are a fence against a third.
//
// WHAT THIS FILE PROVES, AND WHAT IT DOES NOT.
//
// It proves the rendered sentence is exactly the one string a reviewer read and
// agreed was true at merge, and that it contains no queue/send/sync vocabulary.
// The expected string is a literal here, not an import - an assertion that
// compares the component's constant against the component's constant agrees
// with itself no matter what either says.
//
// It does NOT prove the sentence is true. Nothing a unit test can do proves
// that. What makes it true today is that the pill promises only the two things
// T5.1 actually shipped: the connection is down, and the NetworkFirst pages
// route in src/lib/pwa/runtime-caching.ts serves an already-cached document
// when the network does not answer. It deliberately does not name /cards or
// /rewards, because a page the consumer has never opened on this device (or has
// not opened since the last deploy - cache names are build-id scoped) is not in
// Cache Storage and will fall through to /offline.

const EXPECTED_COPY = "You're offline. Pages saved on this device still work.";

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, "onLine", { get: () => value, configurable: true });
}

/**
 * The text a screen reader would actually announce: everything inside the
 * element minus the `aria-hidden` subtrees.
 *
 * Needed because the Material Symbols icon is a ligature - the glyph is
 * produced from the literal text "wifi_off" in the DOM - so a plain
 * `textContent` read would fold an icon name into the sentence and let a
 * copy assertion pass or fail for reasons that have nothing to do with copy.
 */
function announcedText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll("[aria-hidden]")) hidden.remove();
  return (clone.textContent ?? "").trim();
}

afterEach(() => {
  setOnline(true);
  reducedMotion.value = false;
});

describe("OfflineBanner", () => {
  it("renders nothing while the connection is up", () => {
    setOnline(true);
    const { container } = render(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("CRITICAL: says exactly what is true today, and nothing about a queue", () => {
    setOnline(false);
    render(<OfflineBanner />);

    const status = screen.getByRole("status");
    expect(announcedText(status)).toBe(EXPECTED_COPY);
  });

  it("CRITICAL: makes no promise that anything is being kept, sent or synced", () => {
    // Stated separately from the exact-string check above because it is the
    // rule, and it must survive a legitimate rewording. T5.3 is what earns the
    // right to say "queued"; until an enqueue call exists, every one of these
    // words is a lie the consumer cannot check.
    setOnline(false);
    const { container } = render(<OfflineBanner />);
    const text = container.textContent ?? "";

    for (const forbidden of [
      /\bqueue/i,
      /\boutbox\b/i,
      /\bsync/i,
      /\bsend|\bsent\b/i,
      /\bupload/i,
      /\bwe'?ll\b/i,
      /\bautomatic/i,
    ]) {
      expect(text, `matched ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("does not blame the consumer for the connection", () => {
    // Doc 16's tone rule, and the reason "You are offline" reads worse than
    // "You're offline": being in a basement is not a mistake anyone made.
    setOnline(false);
    const { container } = render(<OfflineBanner />);
    const text = container.textContent ?? "";

    for (const forbidden of [/\berror\b/i, /\bfail/i, /\bcheck your\b/i, /\byour connection\b/i]) {
      expect(text, `matched ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("uses no em-dash or en-dash", () => {
    // The house copy rule, pinned the same way receipt-copy.test.ts pins it.
    setOnline(false);
    render(<OfflineBanner />);
    const text = announcedText(screen.getByRole("status"));
    expect(text).not.toContain("—");
    expect(text).not.toContain("–");
  });

  it("announces politely and is not a dialog", () => {
    // Non-blocking is half the requirement in doc 41 section 9. `polite` so a
    // screen reader user mid-sentence hears it at a pause, and no role that
    // would demand a response.
    setOnline(false);
    render(<OfflineBanner />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("CRITICAL: skips the entrance animation for a consumer who asked for less motion", () => {
    // Doc 16: "DO gate animation behind reduced-motion". The pill slides down
    // from -12px at opacity 0; under reduced motion it must simply BE there.
    // Asserted on the committed inline style rather than on the props, because
    // `initial={false}` is only the mechanism - what the consumer gets is an
    // element that is already at its resting position on first paint.
    setOnline(false);
    reducedMotion.value = true;
    render(<OfflineBanner />);

    const style = screen.getByRole("status").getAttribute("style") ?? "";
    expect(style).not.toContain("opacity: 0");
    expect(style).not.toContain("translateY");
  });

  it("does animate in when reduced motion is not requested (the negative case)", () => {
    // Without this, the assertion above is satisfied by a component with no
    // animation at all, which would pass while the gate itself was deleted.
    setOnline(false);
    reducedMotion.value = false;
    render(<OfflineBanner />);

    const style = screen.getByRole("status").getAttribute("style") ?? "";
    expect(style).toContain("opacity: 0");
    expect(style).toContain("translateY(-12px)");
  });

  it("appears and disappears with the connection, without a remount", () => {
    setOnline(true);
    render(<OfflineBanner />);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status")).toBeInTheDocument();

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
