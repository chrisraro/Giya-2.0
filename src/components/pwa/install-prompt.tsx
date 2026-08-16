"use client";

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";

import { Dialog } from "@/components/ui/dialog";
import {
  INSTALL_MOMENT_EVENT,
  canAsk,
  installCapability,
  isInstalled,
  localInstallPromptStorage,
  readInstallEnvironment,
  readInstallPromptRecord,
  recordAsk,
  recordInstalled,
  supportsManualInstallOnly,
  writeInstallPromptRecord,
  type InstallCapability,
} from "@/features/pwa/install-prompt";

/**
 * The install offer (doc 41 section 2).
 *
 * Mounted once, in the consumer layout, and it renders nothing almost all of
 * the time. It has to be mounted early rather than on the screen that triggers
 * it: `beforeinstallprompt` fires on PAGE LOAD, and a client-side navigation
 * into /scan/[receiptId] is not a page load, so a listener attached at the
 * receipt screen would never see one.
 *
 * It shows at exactly one moment - `INSTALL_MOMENT_EVENT`, dispatched when a
 * receipt of theirs reaches `approved` - because that is the first point where
 * "put this on your home screen" is a favour rather than an interruption.
 * Everything about WHETHER to show it is decided in
 * `@/features/pwa/install-prompt`, where it is testable without a browser.
 *
 * ANALYTICS [V1]. Doc 41 section 2 asks for the `appinstalled` outcome to reach
 * doc 40's event stream. There is no client analytics transport in this repo -
 * `src/features/analytics/` is server-side rollup code, not an event sink - and
 * building one for a single event is not this task. The outcome IS recorded
 * locally, which is what the prompt logic needs to stop asking.
 * TODO(analytics): forward `appinstalled` to docs/30-modules/40-analytics.md's
 * collection endpoint once a client event sink exists.
 */

/** The Chrome-only event. Not in lib.dom, so the one field used is declared. */
interface BeforeInstallPromptEvent extends Event {
  readonly prompt: () => Promise<unknown>;
}

export function InstallPrompt() {
  const [offer, setOffer] = React.useState<Exclude<InstallCapability, "none"> | null>(null);
  const deferredRef = React.useRef<BeforeInstallPromptEvent | null>(null);
  // At most one ask per page load, whatever storage says. Belt for the case
  // where `localStorage` cannot be written - Safari with site data blocked, a
  // full quota - where the persisted budget is silently a no-op and the sheet
  // would otherwise return on every approved receipt for the rest of the
  // session. Deliberately NOT the primary mechanism: it dies with the tab.
  const askedThisSessionRef = React.useRef(false);
  const reduce = useReducedMotion();
  const bodyId = React.useId();

  React.useEffect(() => {
    const storage = localInstallPromptStorage;

    function onBeforeInstallPrompt(event: Event) {
      // Doc 41: "Capture beforeinstallprompt, preventDefault(), stash the
      // event." preventDefault is what stops Chrome putting up its own bar at a
      // moment nobody chose, and what keeps the event replayable later.
      event.preventDefault();
      deferredRef.current = event as BeforeInstallPromptEvent;
    }

    function onAppInstalled() {
      // The stashed event is spent the moment the install completes; keeping it
      // would let a later moment offer an install that has already happened.
      deferredRef.current = null;
      writeInstallPromptRecord(storage, recordInstalled(readInstallPromptRecord(storage)));
      setOffer(null);
    }

    function onInstallMoment() {
      if (askedThisSessionRef.current) return;

      const environment = readInstallEnvironment();
      const stored = readInstallPromptRecord(storage);

      // A consumer can install without the `appinstalled` event ever reaching
      // this tab - through the browser menu, on another tab, or on iOS where
      // there is no such event at all - so a standalone window is treated as
      // proof, and latched so no later session pays for the detection again.
      const record = isInstalled(environment) ? recordInstalled(stored) : stored;
      if (record.installed && !stored.installed) writeInstallPromptRecord(storage, record);

      const now = Date.now();
      if (!canAsk(record, now)) return;

      const capability = installCapability({
        deferredEventAvailable: deferredRef.current !== null,
        standaloneDefined: supportsManualInstallOnly(environment),
        // Always false by the time control reaches here - `canAsk` has already
        // refused an installed record - so this is the second lock on one
        // door, and the one that is proved is `installCapability`'s own, in
        // src/features/pwa/install-prompt.test.ts.
        installed: record.installed,
      });
      if (capability === "none") return;

      // Spent on SHOW. See recordAsk's own note: the budget is a budget of
      // interruptions, and a reload with the sheet open must not buy a new one.
      writeInstallPromptRecord(storage, recordAsk(record, now));
      askedThisSessionRef.current = true;
      setOffer(capability);
    }

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    window.addEventListener(INSTALL_MOMENT_EVENT, onInstallMoment);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
      window.removeEventListener(INSTALL_MOMENT_EVENT, onInstallMoment);
    };
  }, []);

  const accept = React.useCallback(() => {
    const deferred = deferredRef.current;
    // Cleared before the call: the specification allows a captured event to be
    // prompted once, and a double tap either throws or does nothing useful.
    deferredRef.current = null;
    setOffer(null);
    void deferred?.prompt();
  }, []);

  return (
    // Mounted unconditionally with `open` toggling, which is how this primitive
    // is designed to be used (see its header). `self-end` is what turns a
    // centred MD3 dialog into a bottom sheet: the scrim is a flex container
    // with `items-center`, and aligning this one child to the end overrides it
    // without touching a primitive six other surfaces share.
    <Dialog
      open={offer !== null}
      onClose={() => setOffer(null)}
      title="Add Giya to your home screen"
      describedById={bodyId}
      className="self-end w-full max-w-md rounded-b-none sm:rounded-b-md3-xl sm:self-auto"
    >
      {/* The panel's own class string belongs to the primitive, so the
          entrance is on the content column instead of the sheet. Gated on
          `useReducedMotion` per doc 16: with it on, the content is simply
          already there. */}
      <motion.div
        data-testid="install-sheet-body"
        className="flex flex-col gap-4"
        initial={reduce ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.25, ease: [0.2, 0, 0, 1] }}
      >
        {/* Doc 41 gives this as "Add Giya to your home screen - your cards,
            one tap away." with an em dash, which the house copy rule bans
            (src/features/receipts/components/receipt-copy.test.ts). The words
            are unchanged; the clause after the dash is now the body under the
            title. */}
        <p id={bodyId} className="text-body-m text-on-surface-variant">
          Your cards, one tap away.
        </p>

        {offer === "manual" ? <ManualInstructions /> : null}

        <div className="flex justify-end gap-2">
          {offer === "manual" ? (
            <button
              type="button"
              onClick={() => setOffer(null)}
              className="h-10 rounded-full bg-primary px-6 text-label-l text-on-primary outline-none transition-opacity duration-200 ease-standard hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary"
            >
              Got it
            </button>
          ) : (
            <>
              {/* "Not now" is a real, equal choice and is labelled as one. The
                  sheet already costs one of three lifetime asks whichever
                  button is pressed, so nothing is gained by hiding the exit. */}
              <button
                type="button"
                onClick={() => setOffer(null)}
                className="h-10 rounded-full px-6 text-label-l text-on-surface-variant outline-none transition-colors duration-200 ease-standard hover:bg-surface-container-highest focus-visible:ring-2 focus-visible:ring-secondary"
              >
                Not now
              </button>
              <button
                type="button"
                onClick={accept}
                className="h-10 rounded-full bg-primary px-6 text-label-l text-on-primary outline-none transition-opacity duration-200 ease-standard hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary"
              >
                Add to home screen
              </button>
            </>
          )}
        </div>
      </motion.div>
    </Dialog>
  );
}

/**
 * Doc 41's iOS row: "Same trigger moments show manual instructions (Share ->
 * Add to Home Screen) with illustrated steps."
 *
 * No browser is named. Every browser on iOS is WebKit and every one of them
 * defines `navigator.standalone`, so "Safari" would be wrong for a consumer
 * running Chrome or Firefox on an iPhone - and the capability check that got
 * us here cannot tell them apart, which is the point of using it.
 */
function ManualInstructions() {
  return (
    <ol className="flex flex-col gap-3">
      {[
        { icon: "ios_share", text: "Tap the Share button in your browser's toolbar." },
        { icon: "add_to_home_screen", text: "Choose Add to Home Screen." },
      ].map((step, index) => (
        <li key={step.icon} className="flex items-center gap-3 text-body-m text-on-surface">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container"
          >
            <span className="material-symbols-rounded text-[20px]">{step.icon}</span>
          </span>
          <span>
            <span className="sr-only">{`Step ${index + 1}: `}</span>
            {step.text}
          </span>
        </li>
      ))}
    </ol>
  );
}
