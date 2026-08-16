/**
 * The install prompt's decisions (doc 41 section 2), with no DOM in them.
 *
 * Everything here is a pure function or a guarded storage read, so the rules
 * that matter - never prompt cold, never prompt an installed app, 14 day
 * cooldown, 3 lifetime asks, iOS gets instructions instead - are testable
 * without rendering anything or faking a browser. The component that acts on
 * them is `src/components/pwa/install-prompt.tsx`.
 *
 * WHOSE BUDGET THIS IS. The ask history lives in `localStorage`, so it is PER
 * DEVICE AND PER BROWSER PROFILE, not per account. The same person on their
 * phone and on a borrowed laptop has two independent budgets, and a second
 * person signing in on the same phone inherits the first one's. That is the
 * right granularity for this question and not merely the cheap one: installing
 * is something you do to a device, and the answer to "is Giya on this home
 * screen?" has nothing to do with which account is signed in. It does mean
 * clearing site data resets the budget, which is a cost worth paying to keep
 * a nudge counter out of the database.
 */

/** The one key. Renaming it resets every consumer's budget to zero. */
export const INSTALL_PROMPT_STORAGE_KEY = "giya.install-prompt.v1";

/** Doc 41 section 2: "Dismiss -> cooldown 14 days". */
export const INSTALL_PROMPT_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

/** Doc 41 section 2: "max 3 lifetime asks". */
export const INSTALL_PROMPT_MAX_ASKS = 3;

/** The window event that says a receipt of theirs just reached `approved`. */
export const INSTALL_MOMENT_EVENT = "giya:install-moment";

export interface InstallPromptRecord {
  /** How many times the sheet has been SHOWN on this device. */
  readonly asks: number;
  /** Epoch ms of the most recent showing, or null if it has never been shown. */
  readonly lastAskedAt: number | null;
  /** Latched once `appinstalled` fires or a standalone window is detected. */
  readonly installed: boolean;
}

export const NEVER_ASKED: InstallPromptRecord = {
  asks: 0,
  lastAskedAt: null,
  installed: false,
};

/** The slice of `Storage` this module uses. Narrow so tests can pass a fake. */
export type InstallPromptStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * `localStorage`, reached lazily.
 *
 * The property access `window.localStorage` is itself what throws when a
 * browser has site data blocked, so it happens INSIDE these two callbacks,
 * where the try/catch in `readInstallPromptRecord`/`writeInstallPromptRecord`
 * covers it. Capturing `window.localStorage` into a constant at module scope
 * would throw at import time, in a module the consumer layout imports.
 */
export const localInstallPromptStorage: InstallPromptStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => {
    window.localStorage.setItem(key, value);
  },
};

/**
 * The two capability signals, read as values so the decisions above them stay
 * pure. Deliberately NOT a user-agent string: doc 41's iOS row is about a
 * capability (Safari fires no `beforeinstallprompt` and defines
 * `navigator.standalone`), and a UA test for it goes stale the first time
 * anybody ships a new browser or lies about themselves.
 */
export interface InstallEnvironment {
  readonly matchMedia?: (query: string) => { readonly matches: boolean };
  /** `navigator.standalone`, which only iOS Safari defines. */
  readonly navigatorStandalone?: unknown;
}

export type InstallCapability = "native" | "manual" | "none";

/** Reads the capability signals off the real globals, safely on the server. */
export function readInstallEnvironment(): InstallEnvironment {
  const media =
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? undefined
      : (query: string) => window.matchMedia(query);

  const standalone =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { standalone?: unknown }).standalone;

  return { ...(media ? { matchMedia: media } : {}), navigatorStandalone: standalone };
}

/**
 * Is Giya already on this home screen?
 *
 * Two signals because no single one covers both platforms: everywhere else the
 * installed app runs with `display-mode: standalone`; iOS Safari reports no
 * such display-mode and sets `navigator.standalone` instead.
 */
export function isInstalled(env: InstallEnvironment): boolean {
  if (env.navigatorStandalone === true) return true;
  return env.matchMedia?.("(display-mode: standalone)").matches === true;
}

/**
 * Is this a browser that will never fire `beforeinstallprompt`?
 *
 * True exactly when `navigator.standalone` is DEFINED, whatever its value: iOS
 * Safari defines it (false in a tab, true on the home screen) and nothing else
 * does. `=== false` would be wrong - that is the tab case, which is precisely
 * when the instructions are needed.
 */
export function supportsManualInstallOnly(env: InstallEnvironment): boolean {
  return env.navigatorStandalone !== undefined;
}

/**
 * What, if anything, can be offered right now.
 *
 * `native` requires a captured event: doc 41's "never prompt cold" is not
 * really a copy rule, it is that with nothing stashed there is nothing for the
 * accept button to call, and a sheet whose primary action does nothing is worse
 * than no sheet at all.
 */
export function installCapability(input: {
  readonly deferredEventAvailable: boolean;
  readonly standaloneDefined: boolean;
  readonly installed: boolean;
}): InstallCapability {
  if (input.installed) return "none";
  if (input.deferredEventAvailable) return "native";
  return input.standaloneDefined ? "manual" : "none";
}

/**
 * May the sheet be shown?
 *
 * `now < lastAskedAt` (a clock correction, a timezone jump, a device with a bad
 * RTC) counts as inside the cooldown. Being silent for too long is a missed
 * install; asking again immediately is the failure the budget exists to stop.
 */
export function canAsk(record: InstallPromptRecord, now: number): boolean {
  if (record.installed) return false;
  if (record.asks >= INSTALL_PROMPT_MAX_ASKS) return false;
  if (record.lastAskedAt === null) return true;
  return now - record.lastAskedAt >= INSTALL_PROMPT_COOLDOWN_MS;
}

/**
 * Spend one ask.
 *
 * Called when the sheet is SHOWN, not when it is dismissed. Doc 41's budget is
 * a budget of interruptions, and somebody who leaves the sheet open and
 * navigates away has still been interrupted. It also means accept needs no
 * separate accounting: an accept that the browser then refuses, or that the
 * consumer cancels inside Chrome's own dialog, does not get a free retry the
 * next time a receipt is approved.
 */
export function recordAsk(record: InstallPromptRecord, now: number): InstallPromptRecord {
  return { ...record, asks: record.asks + 1, lastAskedAt: now };
}

/** Latch "this device has it" without disturbing the ask history. */
export function recordInstalled(record: InstallPromptRecord): InstallPromptRecord {
  return { ...record, installed: true };
}

/**
 * Read the record, treating every failure as "do not ask".
 *
 * This runs inside the consumer layout's subtree on every page, and Safari in
 * private mode throws on `localStorage` access rather than returning null, so
 * an unguarded read here is a blank app. Two directions of leniency, and they
 * are deliberately different:
 *
 *   - NOTHING stored, or storage unreadable -> never asked. A first-time
 *     consumer and a consumer whose browser blocks site data look identical,
 *     and the worst case is one nudge they can dismiss.
 *   - Something stored that does not parse as a whole non-negative integer ->
 *     treated as the CAP, not the floor. A corrupt or hand-edited value must
 *     not read back as `asks: 0` and hand out an unlimited supply of prompts.
 */
export function readInstallPromptRecord(storage: InstallPromptStorage): InstallPromptRecord {
  let raw: string | null;
  try {
    raw = storage.getItem(INSTALL_PROMPT_STORAGE_KEY);
  } catch {
    return NEVER_ASKED;
  }
  if (raw === null) return NEVER_ASKED;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NEVER_ASKED;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return NEVER_ASKED;

  const record = parsed as Record<string, unknown>;

  return {
    asks: asCount(record.asks),
    lastAskedAt: typeof record.lastAskedAt === "number" ? record.lastAskedAt : null,
    installed: record.installed === true,
  };
}

/** Persist, and shrug if the browser will not let us. */
export function writeInstallPromptRecord(
  storage: InstallPromptStorage,
  record: InstallPromptRecord,
): void {
  try {
    storage.setItem(INSTALL_PROMPT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Private mode, blocked site data, or a full quota. The consequence is that
    // the consumer may be asked again on a later approved receipt, which is a
    // survivable amount of wrong; throwing out of a render tree is not.
  }
}

/** A whole non-negative ask count, or the cap if the value cannot be trusted. */
function asCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return INSTALL_PROMPT_MAX_ASKS;
  }
  return value;
}

/**
 * Announce the moment of demonstrated value: a receipt of theirs just reached
 * `approved`.
 *
 * A window event rather than a shared store because the two ends are far apart
 * and neither should own the other. The publisher is the receipt status screen
 * (`src/features/receipts/components/receipt-status.tsx`), which knows nothing
 * about installability; the subscriber is mounted once in the consumer layout
 * and must be listening for `beforeinstallprompt` from first paint, long before
 * any receipt exists. Anything that mounted the listener at the receipt screen
 * instead would miss the event entirely: browsers fire it on page load, and a
 * client-side navigation into /scan/[receiptId] is not one.
 *
 * `target` defaults to `window` and is only ever passed by a test. There is no
 * SSR guard because there is nothing to guard: the one caller is inside a
 * `useEffect`, which does not run on the server, and a fallback branch that can
 * never be reached is a claim no test can check.
 */
export function signalInstallMoment(target: EventTarget = window): void {
  target.dispatchEvent(new Event(INSTALL_MOMENT_EVENT));
}
