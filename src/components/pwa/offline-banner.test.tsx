import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";

// The scan flow's canvas pipeline cannot run in jsdom, so only the compression
// step is stubbed for the one test that drives it. Everything else about that
// flow, including the enqueue this banner's second clause depends on, is real.
vi.mock("@/features/receipts/compress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/receipts/compress")>();
  return {
    ...actual,
    clientSha256: vi.fn().mockResolvedValue(undefined),
    compressReceiptFile: vi.fn().mockResolvedValue({
      blob: new NodeBlob(["jpeg"], { type: "image/jpeg" }) as unknown as Blob,
      width: 2048,
      height: 1536,
      quality: 0.8,
      byteSize: 900_000,
      reducedBeyondDefault: false,
    }),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

function photoFile(): File {
  const file = new File(["x"], "receipt.jpg", { type: "image/jpeg" });
  Object.defineProperty(file, "size", { value: 2048 });
  return file;
}

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
// The copy is the reason most of this file exists. The banner shipped
// (unmounted) with "You are offline. Scanned receipts will be queued in your
// outbox." - a sentence describing T5.3 while `src/features/pwa/outbox.ts` had
// no callers, so a consumer who read that, scanned in a basement and closed the
// tab would lose the receipt AND have been told we kept it. This project has
// shipped that defect twice (/suspended's "you cannot redeem" while redemption
// was ungated; the device list's "does not sign that browser out" while it
// did). T5.2 cut the sentence back to what T5.1 had actually shipped and left
// T5.3 the right to widen it once the enqueue call existed.
//
// T5.3a WIDENED IT. The second clause is now about the outbox, and the test
// below named "the queue clause has a caller" is what keeps that honest: it
// fails if the enqueue call the sentence describes is ever removed, which is
// exactly how the original defect got in.
//
// WHAT THIS FILE PROVES, AND WHAT IT DOES NOT.
//
// It proves the rendered sentence is exactly the one string a reviewer read and
// agreed was true at merge. The expected string is a literal here, not an
// import - an assertion that compares the component's constant against the
// component's constant agrees with itself no matter what either says.
//
// It does NOT prove the sentence is true. What makes it true is that both
// clauses describe present state that this codebase produces: the NetworkFirst
// pages route serves an already-cached document, and every row in
// `receipt_outbox` is bytes in IndexedDB on this device. Neither clause is in
// the future tense, which is what keeps the sentence true on the two paths
// where an enqueue is REFUSED (the 10-item cap, a full disk): a capture that
// was turned away never became a queued receipt, so nothing here speaks for it.

const EXPECTED_COPY =
  "You're offline. Pages saved on this device still work, and queued receipts are still on this phone.";

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

  it("CRITICAL: says exactly what is true today, including the queue clause", () => {
    setOnline(false);
    render(<OfflineBanner />);

    const status = screen.getByRole("status");
    expect(announcedText(status)).toBe(EXPECTED_COPY);
  });

  it("CRITICAL: the queue clause is backed by a receipt that actually lands in storage", async () => {
    // The banner may mention the outbox only because a capture that failed for
    // want of a connection is genuinely written to IndexedDB. That behaviour
    // lives in another module, so nothing about RENDERING this pill notices if
    // it disappears - which is exactly how the original defect shipped: the
    // sentence outlived the behaviour it described and every test here stayed
    // green.
    //
    // So this file drives the real scan flow, offline, against a real
    // IndexedDB, and reads the row back. A first draft asserted the source text
    // of receipt-capture.tsx instead; a mutant that left the enqueue function
    // in place but stopped CALLING it survived that, because the words were
    // still on the page. Words were the original bug.
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("navigator", { onLine: true });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const { ReceiptCapture } = await import("@/features/receipts/components/receipt-capture");
    const { listOutboxItems } = await import("@/features/pwa/outbox");
    render(<ReceiptCapture />);

    fireEvent.change(screen.getByLabelText(/Choose from gallery/), {
      target: { files: [photoFile()] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Use this photo" }));

    await waitFor(async () => expect(await listOutboxItems()).toHaveLength(1));
    vi.unstubAllGlobals();
  });

  it("CRITICAL: promises nothing about a receipt that is not already queued", () => {
    // The rule behind the exact-string check, stated so it survives a
    // legitimate rewording. Every one of these would extend the sentence to
    // captures the 10-item cap or a full disk will REFUSE, which are the two
    // paths where a consumer is told the receipt was not kept. A pill saying
    // otherwise at the same moment would be the fourth time this project
    // shipped copy that outran behaviour.
    setOnline(false);
    const { container } = render(<OfflineBanner />);
    const text = container.textContent ?? "";

    for (const forbidden of [
      /\bwill be\b/i,
      /\bwe'?ll\b/i,
      /\bevery receipt\b/i,
      /\bany receipt\b/i,
      /\banything you scan\b/i,
      /\bautomatic/i,
    ]) {
      expect(text, `matched ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("CRITICAL: promises no durability the platform cannot give", () => {
    // Doc 41 section 8: iOS evicts storage after about seven days of Safari
    // non-use, and "if eviction still claims the outbox, the receipt is gone
    // and we never pretend otherwise". "Still on this phone" is a present-tense
    // fact and survives that; "safe", "never lose" and friends do not.
    setOnline(false);
    const { container } = render(<OfflineBanner />);
    const text = container.textContent ?? "";

    for (const forbidden of [/\bsafe\b/i, /\bnever\b/i, /\bwon'?t lose\b/i, /\bguarantee/i]) {
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

  it("CRITICAL: cannot swallow a tap meant for the page underneath", () => {
    // The other half of doc 41 section 9's "non-blocking", and the half a
    // `role`/`aria-live` assertion says nothing about. The pill is fixed over
    // the content, so without `pointer-events-none` it is a dead strip across
    // the top of every consumer screen for as long as the connection is down -
    // exactly when somebody is most likely to be tapping at things.
    //
    // Asserted on the class rather than by hit-testing because jsdom does not
    // do layout or hit-testing at all: `elementFromPoint` returns null and
    // every box is zero-sized, so there is no honest way to ask "what would
    // this tap hit?" here. This pins the mechanism, and says so.
    setOnline(false);
    render(<OfflineBanner />);

    expect(screen.getByRole("status").className).toContain("pointer-events-none");
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
