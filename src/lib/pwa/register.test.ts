import { describe, expect, it, vi } from "vitest";

import {
  SERVICE_WORKER_SCOPE,
  SERVICE_WORKER_URL,
  postSkipWaiting,
  registerServiceWorker,
  shouldReloadOnControllerChange,
  updateDisposition,
} from "./register";

// THE UPDATE FLOW (doc 41 section 7), as decisions rather than as plumbing.
//
// The flow has one rule that is easy to state and easy to get backwards: a
// waiting worker is NOT activated under a user who is mid-session, because
// activating throws away whatever the page was holding - and the case doc 41
// names is a scan, where the user has been holding a phone still over a receipt.
// So: waiting at launch activates silently; waiting mid-session asks.

describe("registerServiceWorker", () => {
  it("registers /sw.js at the root scope", () => {
    // Root scope, not the consumer subtree: the worker has to be able to serve
    // the `/offline` fallback for a navigation to any URL, including one it has
    // never seen.
    expect(SERVICE_WORKER_URL).toBe("/sw.js");
    expect(SERVICE_WORKER_SCOPE).toBe("/");
  });

  it("passes exactly that URL and scope to the browser", async () => {
    const registration = {} as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);

    await expect(
      registerServiceWorker({ register } as unknown as ServiceWorkerContainer),
    ).resolves.toBe(registration);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("CRITICAL: does nothing when service workers are unavailable", async () => {
    // iOS below 16.4 in a tab, any insecure origin, and every server render.
    // A PWA that throws where it cannot be a PWA is worse than no PWA.
    await expect(registerServiceWorker(undefined)).resolves.toBeNull();
  });

  it("CRITICAL: survives a rejected registration instead of taking the app with it", async () => {
    // Registration fails for reasons that have nothing to do with us - a
    // private window, a corporate policy, a browser that has run out of
    // storage. None of them should stop the page rendering.
    const register = vi.fn().mockRejectedValue(new Error("SecurityError"));
    await expect(
      registerServiceWorker({ register } as unknown as ServiceWorkerContainer),
    ).resolves.toBeNull();
  });
});

describe("updateDisposition", () => {
  it("does nothing when no worker is waiting", () => {
    expect(
      updateDisposition({ hasWaiting: false, hasController: true, phase: "session" }),
    ).toBe("none");
    expect(updateDisposition({ hasWaiting: false, hasController: true, phase: "launch" })).toBe(
      "none",
    );
  });

  it("activates a worker that was already waiting when the app opened", () => {
    // Doc 41 section 7 step 4, the auto-activate exception: before the first
    // interaction there is nothing in flight to lose, so asking would be a
    // dialog about nothing.
    expect(updateDisposition({ hasWaiting: true, hasController: true, phase: "launch" })).toBe(
      "activate-now",
    );
  });

  it("CRITICAL: offers rather than activates when a worker starts waiting mid-session", () => {
    // The case the whole `skipWaiting: false` decision exists for. Activating
    // here swaps the worker under a page that may be halfway through a capture.
    expect(updateDisposition({ hasWaiting: true, hasController: true, phase: "session" })).toBe(
      "offer",
    );
  });

  it("stays quiet on a first install, which has nothing to update FROM", () => {
    // No controller means this is the very first worker for this origin. It
    // activates on its own; there is no old version to offer to replace, and a
    // "new version ready" toast on a first visit is a lie.
    expect(updateDisposition({ hasWaiting: true, hasController: false, phase: "session" })).toBe(
      "none",
    );
  });
});

describe("postSkipWaiting", () => {
  it("CRITICAL: posts exactly the SKIP_WAITING payload the worker listens for", () => {
    // Asserted as a literal. The worker and the page agree on this string and
    // nothing else; get it wrong and the Refresh button is a button that does
    // nothing, forever, with no error anywhere.
    const postMessage = vi.fn();
    const posted = postSkipWaiting({
      waiting: { postMessage },
    } as unknown as ServiceWorkerRegistration);

    expect(posted).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  });

  it("reports that it did nothing when there is no waiting worker", () => {
    expect(postSkipWaiting({ waiting: null } as ServiceWorkerRegistration)).toBe(false);
  });
});

describe("shouldReloadOnControllerChange", () => {
  it("reloads once when a new worker takes over from an old one", () => {
    expect(
      shouldReloadOnControllerChange({ hadControllerAtMount: true, alreadyReloading: false }),
    ).toBe(true);
  });

  it("CRITICAL: does not reload on the first install", () => {
    // `clientsClaim` makes the very first worker take control of the page that
    // registered it, which fires controllerchange with no old version involved.
    // Reloading there is a blank flash on a first visit for no reason.
    expect(
      shouldReloadOnControllerChange({ hadControllerAtMount: false, alreadyReloading: false }),
    ).toBe(false);
  });

  it("CRITICAL: does not reload twice", () => {
    // controllerchange can fire more than once. A second reload restarts a page
    // that is already restarting, which is how a reload loop starts.
    expect(
      shouldReloadOnControllerChange({ hadControllerAtMount: true, alreadyReloading: true }),
    ).toBe(false);
  });
});
