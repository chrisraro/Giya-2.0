"use client";

import { useEffect, useState } from "react";

import {
  postSkipWaiting,
  registerServiceWorker,
  shouldReloadOnControllerChange,
  updateDisposition,
  type UpdatePhase,
} from "@/lib/pwa/register";

import { UpdateToast } from "./update-toast";

/**
 * Registers the service worker and runs doc 41 section 7's update flow.
 *
 * Mounted from the CONSUMER layout only. The business and admin portals are
 * excluded from service worker scope (doc 41's preamble): staff decisions -
 * redemption validation, review queues - must never be made against a cached
 * page, and an admin document sitting in Cache Storage on a shared back-office
 * device is a data-exposure risk with no upside. That exclusion is asserted by
 * src/app/service-worker-scope.test.ts, and is also why next.config.ts turns
 * @serwist/next's own auto-registration off: it runs on every app-router page.
 *
 * All the decisions this component acts on live in `@/lib/pwa/register`, where
 * they are testable without a service worker. What is here is the wiring
 * between them and the browser events that trigger them.
 */
export function RegisterServiceWorker() {
  const [waiting, setWaiting] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
    if (!container) return;

    let cancelled = false;
    let reloading = false;
    // Captured before registering: whether this page was ALREADY under a
    // worker's control tells a genuine update apart from a first install.
    const hadControllerAtMount = container.controller !== null;

    function onControllerChange() {
      if (
        !shouldReloadOnControllerChange({ hadControllerAtMount, alreadyReloading: reloading })
      ) {
        return;
      }
      reloading = true;
      window.location.reload();
    }

    container.addEventListener("controllerchange", onControllerChange);

    void registerServiceWorker(container).then((registration) => {
      if (registration === null || cancelled) return;

      function decide(phase: UpdatePhase) {
        if (registration === null) return;
        switch (
          updateDisposition({
            hasWaiting: registration.waiting !== null,
            hasController: container !== undefined && container.controller !== null,
            phase,
          })
        ) {
          case "activate-now":
            postSkipWaiting(registration);
            return;
          case "offer":
            setWaiting(registration);
            return;
          case "none":
            return;
        }
      }

      decide("launch");

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (installing === null) return;
        installing.addEventListener("statechange", () => {
          // "installed" with an existing controller is the moment the new
          // worker becomes `waiting` - the moment there is something to offer.
          if (installing.state === "installed") decide("session");
        });
      });
    });

    return () => {
      cancelled = true;
      container.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  if (waiting === null) return null;

  return (
    <UpdateToast
      onRefresh={() => {
        postSkipWaiting(waiting);
        // The toast goes as soon as the request is made. `controllerchange`
        // reloads the page a moment later; leaving it up until then would
        // present a button that has already been pressed.
        setWaiting(null);
      }}
      onDismiss={() => setWaiting(null)}
    />
  );
}
