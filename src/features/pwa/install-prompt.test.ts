import { describe, expect, it, vi } from "vitest";

import {
  INSTALL_MOMENT_EVENT,
  INSTALL_PROMPT_COOLDOWN_MS,
  INSTALL_PROMPT_MAX_ASKS,
  INSTALL_PROMPT_STORAGE_KEY,
  NEVER_ASKED,
  canAsk,
  installCapability,
  isInstalled,
  readInstallEnvironment,
  readInstallPromptRecord,
  recordAsk,
  recordInstalled,
  signalInstallMoment,
  supportsManualInstallOnly,
  writeInstallPromptRecord,
  type InstallPromptRecord,
  type InstallPromptStorage,
} from "./install-prompt";

// The install prompt's decisions, with no DOM and no component in the way.
//
// Doc 41 section 2: never prompt cold; trigger after the first approved
// receipt; dismiss costs a 14 day cooldown and there are at most 3 lifetime
// asks; never prompt someone who has already installed; iOS has no
// `beforeinstallprompt` and gets manual instructions at the same moment.
//
// Every number below is written as a literal here, not imported from the module
// and not derived from the module's own constants. `expect(COOLDOWN).toBe(
// COOLDOWN)` agrees with itself whatever the constant says, and doc 41's "14
// days" and "max 3" are the requirement - the constants are only how it is
// spelled.

const DAY_MS = 86_400_000;
const T0 = Date.parse("2026-08-16T00:00:00.000Z");

function fakeStorage(initial?: string): InstallPromptStorage & { readonly written: string[] } {
  const written: string[] = [];
  let value = initial;
  return {
    written,
    getItem: (key: string) => (key === INSTALL_PROMPT_STORAGE_KEY ? (value ?? null) : null),
    setItem: (key: string, next: string) => {
      if (key !== INSTALL_PROMPT_STORAGE_KEY) return;
      value = next;
      written.push(next);
    },
  };
}

describe("the numbers doc 41 section 2 actually specifies", () => {
  it("CRITICAL: the cooldown is 14 days", () => {
    expect(INSTALL_PROMPT_COOLDOWN_MS).toBe(1_209_600_000);
  });

  it("CRITICAL: there are at most 3 lifetime asks", () => {
    expect(INSTALL_PROMPT_MAX_ASKS).toBe(3);
  });
});

describe("canAsk", () => {
  const fresh: InstallPromptRecord = { asks: 0, lastAskedAt: null, installed: false };

  it("asks somebody who has never been asked", () => {
    expect(canAsk(fresh, T0)).toBe(true);
  });

  it("CRITICAL: never asks somebody who has already installed", () => {
    // Doc 41 section 2, and the one rule whose failure is pure noise: a
    // standalone window offering to add itself to the home screen.
    expect(canAsk({ asks: 0, lastAskedAt: null, installed: true }, T0)).toBe(false);
  });

  it("CRITICAL: stays silent for 14 days after an ask", () => {
    const asked = { asks: 1, lastAskedAt: T0, installed: false };

    expect(canAsk(asked, T0)).toBe(false);
    expect(canAsk(asked, T0 + 13 * DAY_MS)).toBe(false);
    // The boundary, to the minute: 14 days minus one minute is still silent.
    expect(canAsk(asked, T0 + 14 * DAY_MS - 60_000)).toBe(false);
  });

  it("CRITICAL: asks again once 14 days have passed", () => {
    // The negative of the rule above. Without it, `canAsk() => false` passes
    // the cooldown test and the prompt is dead forever after one dismissal.
    const asked = { asks: 1, lastAskedAt: T0, installed: false };

    expect(canAsk(asked, T0 + 14 * DAY_MS)).toBe(true);
    expect(canAsk(asked, T0 + 30 * DAY_MS)).toBe(true);
  });

  it("CRITICAL: stops forever after the third ask, however long they wait", () => {
    const spent = { asks: 3, lastAskedAt: T0, installed: false };

    expect(canAsk(spent, T0 + 14 * DAY_MS)).toBe(false);
    expect(canAsk(spent, T0 + 3650 * DAY_MS)).toBe(false);
  });

  it("still asks on the third time, so the cap is 3 and not 2", () => {
    const twice = { asks: 2, lastAskedAt: T0, installed: false };

    expect(canAsk(twice, T0 + 14 * DAY_MS)).toBe(true);
  });

  it("treats a clock that has gone backwards as still inside the cooldown", () => {
    // Timezone changes, a manual clock correction, and a device that boots with
    // a bad RTC all produce `now < lastAskedAt`. Asking again immediately would
    // be the wrong way to be wrong.
    const asked = { asks: 1, lastAskedAt: T0, installed: false };

    expect(canAsk(asked, T0 - 5 * DAY_MS)).toBe(false);
    // Past the cooldown's own width, which is where a `Math.abs` on the
    // elapsed time would start reading a clock that ran BACKWARDS as one that
    // had run forwards for a fortnight.
    expect(canAsk(asked, T0 - 20 * DAY_MS)).toBe(false);
  });
});

describe("recordAsk", () => {
  it("counts the ask and starts the cooldown at the moment it was SHOWN", () => {
    // Shown, not dismissed. The consumer who leaves the sheet open and
    // navigates away has still been asked, and doc 41's budget is a budget of
    // interruptions. It also means accept and dismiss need no separate
    // accounting - see the module header.
    expect(recordAsk(NEVER_ASKED, T0)).toEqual({ asks: 1, lastAskedAt: T0, installed: false });
  });

  it("accumulates", () => {
    const twice = recordAsk(recordAsk(NEVER_ASKED, T0), T0 + 20 * DAY_MS);
    expect(twice).toEqual({ asks: 2, lastAskedAt: T0 + 20 * DAY_MS, installed: false });
  });

  it("does not mutate its input", () => {
    const before = { asks: 1, lastAskedAt: T0, installed: false };
    recordAsk(before, T0 + DAY_MS);
    expect(before).toEqual({ asks: 1, lastAskedAt: T0, installed: false });
  });
});

describe("recordInstalled", () => {
  it("CRITICAL: latches installed without disturbing the ask history", () => {
    expect(recordInstalled({ asks: 2, lastAskedAt: T0, installed: false })).toEqual({
      asks: 2,
      lastAskedAt: T0,
      installed: true,
    });
  });
});

describe("readInstallPromptRecord", () => {
  it("returns the never-asked record when nothing is stored", () => {
    expect(readInstallPromptRecord(fakeStorage())).toEqual({
      asks: 0,
      lastAskedAt: null,
      installed: false,
    });
  });

  it("round-trips through write", () => {
    const storage = fakeStorage();
    writeInstallPromptRecord(storage, { asks: 2, lastAskedAt: T0, installed: true });

    expect(readInstallPromptRecord(storage)).toEqual({
      asks: 2,
      lastAskedAt: T0,
      installed: true,
    });
  });

  it("CRITICAL: treats unreadable storage as never-asked rather than throwing", () => {
    // Safari in private mode, and any browser with site data blocked, throw on
    // localStorage access. This runs inside the consumer layout's subtree on
    // every page: a throw here is a blank app, and the worst honest outcome of
    // a failed read is one extra install nudge.
    const throwing: InstallPromptStorage = {
      getItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    };

    expect(() => readInstallPromptRecord(throwing)).not.toThrow();
    expect(readInstallPromptRecord(throwing)).toEqual({
      asks: 0,
      lastAskedAt: null,
      installed: false,
    });
  });

  it("CRITICAL: a write to unreadable storage does not throw either", () => {
    const throwing: InstallPromptStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    };

    expect(() => writeInstallPromptRecord(throwing, recordAsk(NEVER_ASKED, T0))).not.toThrow();
  });

  it("survives corrupt JSON and wrong-shaped JSON", () => {
    expect(readInstallPromptRecord(fakeStorage("{not json"))).toEqual(NEVER_ASKED);
    expect(readInstallPromptRecord(fakeStorage("null"))).toEqual(NEVER_ASKED);
    expect(readInstallPromptRecord(fakeStorage("[1,2,3]"))).toEqual(NEVER_ASKED);
    expect(readInstallPromptRecord(fakeStorage('"three"'))).toEqual(NEVER_ASKED);
  });

  it("CRITICAL: a stored record that cannot be trusted counts as spent, not as fresh", () => {
    // The failure to avoid is a garbage or hand-edited value reading back as
    // `asks: 0` and handing somebody an unlimited supply of install prompts.
    // A field present but not a number is treated as the cap, not the floor.
    expect(readInstallPromptRecord(fakeStorage('{"asks":"lots","lastAskedAt":null}'))).toEqual({
      asks: 3,
      lastAskedAt: null,
      installed: false,
    });
    expect(canAsk(readInstallPromptRecord(fakeStorage('{"asks":-5}')), T0)).toBe(false);
    expect(canAsk(readInstallPromptRecord(fakeStorage('{"asks":1.5}')), T0)).toBe(false);
  });

  it("reads `installed` as a boolean and nothing else", () => {
    expect(readInstallPromptRecord(fakeStorage('{"asks":0,"installed":"yes"}')).installed).toBe(
      false,
    );
    expect(readInstallPromptRecord(fakeStorage('{"asks":0,"installed":true}')).installed).toBe(
      true,
    );
  });

  it("stores under one documented key", () => {
    // Named as a literal so a rename is a deliberate act: changing it resets
    // every consumer's ask budget to zero on their next approved receipt.
    expect(INSTALL_PROMPT_STORAGE_KEY).toBe("giya.install-prompt.v1");
  });
});

describe("isInstalled", () => {
  it("CRITICAL: a standalone display-mode means installed", () => {
    const matched = vi.fn((query: string) => ({ matches: query === "(display-mode: standalone)" }));

    expect(isInstalled({ matchMedia: matched })).toBe(true);
    expect(matched).toHaveBeenCalledWith("(display-mode: standalone)");
  });

  it("CRITICAL: iOS `navigator.standalone === true` means installed", () => {
    // iOS Safari does not report a standalone display-mode; this is the only
    // signal there is, and it is a capability read, not a UA string.
    expect(isInstalled({ navigatorStandalone: true })).toBe(true);
  });

  it("a browser tab is not installed", () => {
    expect(isInstalled({ matchMedia: () => ({ matches: false }), navigatorStandalone: false })).toBe(
      false,
    );
    expect(isInstalled({})).toBe(false);
  });

  it("does not read `navigator.standalone: false` as installed", () => {
    // iOS in a normal tab. Without this the prompt would never show on the one
    // platform that needs the manual instructions.
    expect(isInstalled({ matchMedia: () => ({ matches: false }), navigatorStandalone: false })).toBe(
      false,
    );
  });

  it("survives a browser with no matchMedia", () => {
    expect(() => isInstalled({ navigatorStandalone: undefined })).not.toThrow();
  });
});

describe("supportsManualInstallOnly", () => {
  it("CRITICAL: is true exactly when `navigator.standalone` exists", () => {
    // Doc 41's iOS row. The honest signal is the capability - iOS Safari is the
    // only engine that defines `navigator.standalone` - and NOT a UA string,
    // which rots the moment a browser lies about itself or Apple ships a new
    // one.
    expect(supportsManualInstallOnly({ navigatorStandalone: false })).toBe(true);
    expect(supportsManualInstallOnly({ navigatorStandalone: true })).toBe(true);
    expect(supportsManualInstallOnly({})).toBe(false);
    expect(supportsManualInstallOnly({ navigatorStandalone: undefined })).toBe(false);
  });
});

describe("installCapability", () => {
  it("CRITICAL: is 'native' only once a beforeinstallprompt event is in hand", () => {
    // "Never prompt cold" is not a copy rule, it is this: with no captured
    // event there is nothing to call `prompt()` on, and a sheet whose accept
    // button does nothing is worse than no sheet.
    expect(
      installCapability({
        deferredEventAvailable: true,
        standaloneDefined: false,
        installed: false,
      }),
    ).toBe("native");

    expect(
      installCapability({
        deferredEventAvailable: false,
        standaloneDefined: false,
        installed: false,
      }),
    ).toBe("none");
  });

  it("CRITICAL: falls back to manual instructions on iOS", () => {
    expect(
      installCapability({
        deferredEventAvailable: false,
        standaloneDefined: true,
        installed: false,
      }),
    ).toBe("manual");
  });

  it("CRITICAL: an installed app gets nothing, whatever else is true", () => {
    for (const deferredEventAvailable of [true, false]) {
      for (const standaloneDefined of [true, false]) {
        expect(
          installCapability({ deferredEventAvailable, standaloneDefined, installed: true }),
          `deferred=${deferredEventAvailable} standalone=${standaloneDefined}`,
        ).toBe("none");
      }
    }
  });

  it("prefers the real prompt over instructions when both are possible", () => {
    // A hypothetical engine that fires beforeinstallprompt AND defines
    // navigator.standalone should get the one-tap install, not a page of steps.
    expect(
      installCapability({ deferredEventAvailable: true, standaloneDefined: true, installed: false }),
    ).toBe("native");
  });
});

describe("readInstallEnvironment", () => {
  it("CRITICAL: forwards the display-mode query to the real window.matchMedia", () => {
    // The seam between the pure decisions above and the globals. Asserted by
    // making the stub answer `true` and watching `isInstalled` agree: a version
    // that built the environment but never wired matchMedia through would
    // return false here and every other test in this file would still pass.
    const queries: string[] = [];
    vi.stubGlobal("matchMedia", (query: string) => {
      queries.push(query);
      return { matches: true };
    });

    expect(isInstalled(readInstallEnvironment())).toBe(true);
    expect(queries).toEqual(["(display-mode: standalone)"]);

    vi.unstubAllGlobals();
  });

  it("does not invent a matchMedia the browser does not have", () => {
    // jsdom itself ships no `window.matchMedia`, and neither do a handful of
    // real embedded webviews. The read must degrade, not throw.
    vi.stubGlobal("matchMedia", undefined);

    expect(readInstallEnvironment().matchMedia).toBeUndefined();
    expect(isInstalled(readInstallEnvironment())).toBe(false);

    vi.unstubAllGlobals();
  });

  it("reads a non-iOS browser as having no manual fallback", () => {
    expect(readInstallEnvironment().navigatorStandalone).toBeUndefined();
    expect(supportsManualInstallOnly(readInstallEnvironment())).toBe(false);
  });

  it("CRITICAL: reads iOS Safari's navigator.standalone off the real navigator", () => {
    Object.defineProperty(navigator, "standalone", { value: false, configurable: true });

    expect(supportsManualInstallOnly(readInstallEnvironment())).toBe(true);
    expect(isInstalled(readInstallEnvironment())).toBe(false);

    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    expect(isInstalled(readInstallEnvironment())).toBe(true);

    delete (navigator as { standalone?: unknown }).standalone;
  });
});

describe("signalInstallMoment", () => {
  it("CRITICAL: dispatches the moment-of-value event the prompt listens for", () => {
    const seen: string[] = [];
    const listener = () => seen.push("fired");
    window.addEventListener(INSTALL_MOMENT_EVENT, listener);

    signalInstallMoment();

    window.removeEventListener(INSTALL_MOMENT_EVENT, listener);
    expect(seen).toEqual(["fired"]);
  });

  it("uses a namespaced event name", () => {
    expect(INSTALL_MOMENT_EVENT).toBe("giya:install-moment");
  });

  it("dispatches on the target it is given, and not on window as well", () => {
    // The seam the component tests use. Without it, `signalInstallMoment` would
    // be exercised only through its default argument and nothing would notice a
    // version that ignored the parameter.
    const other = new EventTarget();
    const seen: string[] = [];
    other.addEventListener(INSTALL_MOMENT_EVENT, () => seen.push("other"));
    const onWindow = () => seen.push("window");
    window.addEventListener(INSTALL_MOMENT_EVENT, onWindow);

    signalInstallMoment(other);

    window.removeEventListener(INSTALL_MOMENT_EVENT, onWindow);
    expect(seen).toEqual(["other"]);
  });
});
