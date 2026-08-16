import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INSTALL_PROMPT_STORAGE_KEY,
  signalInstallMoment,
  type InstallPromptRecord,
} from "@/features/pwa/install-prompt";

// THE INSTALL PROMPT, AT THE SEAM WHERE THE BROWSER MEETS THE RULES.
//
// The rules themselves (14 days, 3 asks, never when installed, iOS gets
// instructions) are decided in src/features/pwa/install-prompt.ts and proved
// there against literals. What is left for this file is the wiring, and it is
// the half that cannot be proved by a pure function:
//
//   - `beforeinstallprompt` is caught and `preventDefault()`ed, so the browser
//     does not put up its own bar and the event is ours to replay later.
//   - Nothing is shown until the moment of demonstrated value arrives.
//   - Accept calls `prompt()` on THAT event, once.
//   - The ask is written to storage at the moment it is shown, so a reload
//     cannot buy a fresh budget.
//
// WHAT THIS FILE DOES NOT PROVE. It does not prove the trigger is a consumer's
// first approved receipt - that is the publisher's end, asserted in
// src/features/receipts/components/receipt-status.test.tsx - and it does not
// prove the sheet is mounted anywhere, which is
// src/app/(consumer)/layout.test.tsx and src/app/offline-ui-scope.test.ts.

// A NOTE FOR WHOEVER TOUCHES STORAGE NEXT. This project's jsdom environment
// has NO `window.localStorage` - Node 22's own experimental implementation
// shadows jsdom's and resolves to `undefined` without `--localstorage-file`,
// while `window.sessionStorage` survives. So the store is supplied here
// explicitly. Nothing about that is a statement about browsers, where
// localStorage is universal; it only means a test that assumed jsdom provided
// one would fail confusingly, or worse, pass while measuring nothing.
function installLocalStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, String(value));
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
      clear: () => {
        map.clear();
      },
    },
  });
}

/** Safari with site data blocked: the PROPERTY ACCESS throws, not the method. */
function installHostileLocalStorage(): void {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });
}

const reducedMotion = vi.hoisted(() => ({ value: false }));

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => reducedMotion.value };
});

const { InstallPrompt } = await import("./install-prompt");

const TITLE = "Add Giya to your home screen";
const BODY = "Your cards, one tap away.";
const ACCEPT = "Add to home screen";
const DISMISS = "Not now";

const DAY_MS = 86_400_000;

interface FiredPrompt {
  readonly event: Event;
  readonly prompt: ReturnType<typeof vi.fn>;
}

/** What Chrome dispatches when the app becomes installable. */
function fireBeforeInstallPrompt(): FiredPrompt {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  const prompt = vi.fn(() => Promise.resolve());
  Object.assign(event, { prompt });
  act(() => {
    window.dispatchEvent(event);
  });
  return { event, prompt };
}

function moment(): void {
  act(() => {
    signalInstallMoment();
  });
}

function seed(record: Partial<InstallPromptRecord>): void {
  window.localStorage.setItem(
    INSTALL_PROMPT_STORAGE_KEY,
    JSON.stringify({ asks: 0, lastAskedAt: null, installed: false, ...record }),
  );
}

function stored(): InstallPromptRecord | null {
  const raw = window.localStorage.getItem(INSTALL_PROMPT_STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as InstallPromptRecord);
}

/** iOS Safari, which defines `navigator.standalone` and fires no install event. */
function pretendIOS(installedToHomeScreen: boolean): void {
  Object.defineProperty(navigator, "standalone", {
    value: installedToHomeScreen,
    configurable: true,
  });
}

function pretendStandaloneDisplayMode(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(display-mode: standalone)",
  }));
}

beforeEach(() => {
  installLocalStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { standalone?: unknown }).standalone;
  reducedMotion.value = false;
});

describe("never prompt cold", () => {
  it("CRITICAL: shows nothing on mount, and nothing when the browser offers", () => {
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("CRITICAL: suppresses the browser's own install bar by preventing the event", () => {
    // Without preventDefault() Chrome shows its mini-infobar at a moment we did
    // not choose, and the event is consumed rather than stashed for later.
    render(<InstallPrompt />);
    const { event } = fireBeforeInstallPrompt();

    expect(event.defaultPrevented).toBe(true);
  });

  it("CRITICAL: shows nothing at the value moment if no install event was ever captured", () => {
    // A desktop browser with no install support, or one that has decided the
    // app is not installable. There is nothing for accept to call, so a sheet
    // here would be a button that does nothing.
    render(<InstallPrompt />);
    moment();

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the ask itself", () => {
  it("CRITICAL: appears at the moment of demonstrated value, with doc 41's copy", () => {
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    moment();

    const dialog = screen.getByRole("dialog");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(TITLE);
    expect(dialog.textContent).toContain(BODY);
  });

  it("CRITICAL: accept calls prompt() on the captured event, exactly once", () => {
    render(<InstallPrompt />);
    const { prompt } = fireBeforeInstallPrompt();
    moment();

    fireEvent.click(screen.getByRole("button", { name: ACCEPT }));

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dismiss closes it without calling prompt()", () => {
    render(<InstallPrompt />);
    const { prompt } = fireBeforeInstallPrompt();
    moment();

    fireEvent.click(screen.getByRole("button", { name: DISMISS }));

    expect(prompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers a real refusal, not just a way out", () => {
    // "Not now" is an equal, labelled choice. A sheet whose only exit is the
    // scrim or the X reads as a thing you have to get past.
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    moment();

    expect(screen.getByRole("button", { name: DISMISS })).toBeInTheDocument();
  });

  it("uses no em-dash or en-dash", () => {
    // Doc 41 writes the copy as "Add Giya to your home screen - your cards, one
    // tap away." with an em dash. The house rule (receipt-copy.test.ts) bans
    // it, so the clause becomes the sheet's body under the sheet's title; the
    // words are unchanged.
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    moment();

    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).not.toContain("—");
    expect(text).not.toContain("–");
  });
});

describe("iOS, detected by capability and not by user agent", () => {
  it("CRITICAL: shows manual instructions when no install event can ever fire", () => {
    pretendIOS(false);
    render(<InstallPrompt />);
    moment();

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Share");
    expect(dialog.textContent).toContain("Add to Home Screen");
  });

  it("CRITICAL: offers no accept button there, because there is nothing to accept", () => {
    // The failure this stops is a shared sheet: the same accept button on iOS,
    // wired to a `prompt()` that does not exist.
    pretendIOS(false);
    render(<InstallPrompt />);
    moment();

    expect(screen.queryByRole("button", { name: ACCEPT })).toBeNull();
  });

  it("names no browser it cannot be sure of", () => {
    // Every iOS browser is WebKit and every one of them defines
    // navigator.standalone, so "Safari" would be wrong for a consumer using
    // Chrome or Firefox on an iPhone.
    pretendIOS(false);
    render(<InstallPrompt />);
    moment();

    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).not.toContain("Safari");
    expect(text).not.toContain("iPhone");
  });
});

describe("never when it is already installed", () => {
  it("CRITICAL: display-mode standalone silences it, even with an event in hand", () => {
    pretendStandaloneDisplayMode();
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    moment();

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("CRITICAL: iOS navigator.standalone === true silences it", () => {
    pretendIOS(true);
    render(<InstallPrompt />);
    moment();

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("CRITICAL: `appinstalled` stops it asking on any later device session", () => {
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();

    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });

    expect(stored()?.installed).toBe(true);

    moment();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("CRITICAL: latches a standalone window, so the next session need not detect it", () => {
    // An install can happen without `appinstalled` ever reaching this tab: the
    // browser menu, another tab, or iOS, which fires no such event at all.
    // Writing the detection down is what makes those cases permanent instead
    // of re-derived, and it is the only reason the read is worth doing here.
    pretendStandaloneDisplayMode();
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    moment();

    expect(stored()?.installed).toBe(true);
    expect(stored()?.asks).toBe(0);
  });

  it("remembers an install that happened in an earlier session", () => {
    seed({ installed: true });
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    moment();

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the budget, across sessions", () => {
  it("CRITICAL: writes the ask down the moment the sheet is shown", () => {
    // Persisted on SHOW, not on dismiss. Otherwise a reload with the sheet
    // still open, or a consumer who navigates away from it, buys a fresh
    // budget on the next approved receipt.
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    moment();

    expect(stored()?.asks).toBe(1);
    expect(typeof stored()?.lastAskedAt).toBe("number");
  });

  it("CRITICAL: does not ask twice in the same session", () => {
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    moment();
    fireEvent.click(screen.getByRole("button", { name: DISMISS }));

    moment();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stored()?.asks).toBe(1);
  });

  it("CRITICAL: stays quiet for a consumer asked yesterday", () => {
    seed({ asks: 1, lastAskedAt: Date.now() - DAY_MS });
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    moment();

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("CRITICAL: asks again once the 14 days are up", () => {
    // The negative of the rule above: without it, "never shows" passes the
    // cooldown tests and the prompt is dead after one dismissal.
    seed({ asks: 1, lastAskedAt: Date.now() - 15 * DAY_MS });
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    moment();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(stored()?.asks).toBe(2);
  });

  it("CRITICAL: stops after the third ask, however long they wait", () => {
    seed({ asks: 3, lastAskedAt: Date.now() - 3650 * DAY_MS });
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    moment();

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("housekeeping", () => {
  it("CRITICAL: stops listening when it unmounts", () => {
    // Observable rather than asserted through a spy on removeEventListener: a
    // still-attached handler would preventDefault this event.
    const { unmount } = render(<InstallPrompt />);
    unmount();

    const { event } = fireBeforeInstallPrompt();
    expect(event.defaultPrevented).toBe(false);
  });

  it("CRITICAL: skips the entrance animation for a consumer who asked for less motion", () => {
    reducedMotion.value = true;
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    moment();

    const style = screen.getByTestId("install-sheet-body").getAttribute("style") ?? "";
    expect(style).not.toContain("opacity: 0");
    expect(style).not.toContain("translateY");
  });

  it("does animate in otherwise (the negative case)", () => {
    reducedMotion.value = false;
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    moment();

    const style = screen.getByTestId("install-sheet-body").getAttribute("style") ?? "";
    expect(style).toContain("opacity: 0");
    expect(style).toContain("translateY");
  });

  it("CRITICAL: survives a browser that throws on localStorage", () => {
    // Safari with site data blocked, where reading the PROPERTY throws. This
    // component sits in the consumer layout's subtree on every page; a throw
    // here is a blank app, which is why the storage adapter reaches for
    // `window.localStorage` inside its callbacks rather than at module scope.
    installHostileLocalStorage();

    expect(() => {
      render(<InstallPrompt />);
      fireBeforeInstallPrompt();
      moment();
    }).not.toThrow();

    // It degrades to "never asked", so it does ask once...
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: DISMISS }));

    // ...but not again, and not on every approved receipt for the rest of the
    // session. With nothing writable, the only thing standing between this
    // consumer and an endless nag is the in-memory latch.
    moment();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
