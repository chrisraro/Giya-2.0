import { SKIP_WAITING_MESSAGE } from "./messages";

/**
 * Registering the worker, and the update flow's decisions (doc 41 section 7).
 *
 * The decisions live here, apart from the React component that acts on them, so
 * they can be stated and tested as decisions. The one that matters:
 *
 *   waiting worker found at LAUNCH    -> activate it silently (section 7 step 4)
 *   waiting worker appears MID-SESSION -> offer, never activate (step 3)
 *
 * The second is why the worker ships with `skipWaiting: false`. Swapping the
 * worker under a live page throws away what that page was holding, and the case
 * doc 41 names is a receipt capture - someone standing in a shop holding a
 * phone still over a piece of paper.
 */

/** Where @serwist/next writes the compiled worker (`swDest` in next.config.ts). */
export const SERVICE_WORKER_URL = "/sw.js";

/**
 * Root scope, not the consumer subtree.
 *
 * The worker's first job is answering a navigation the network cannot, and that
 * navigation can be to any URL - including one this app has never rendered. A
 * worker scoped to `/home` would sit out exactly the requests the `/offline`
 * fallback exists for. Which SURFACES mount the registration is a separate
 * question, answered in the consumer layout and asserted by
 * src/app/service-worker-scope.test.ts.
 */
export const SERVICE_WORKER_SCOPE = "/";

/**
 * Registers the worker, or resolves `null` when that is not possible.
 *
 * Never rejects. `navigator.serviceWorker` is absent on insecure origins, in
 * some private windows, on iOS below 16.4 outside an installed app, and during
 * every server render; `register()` itself rejects for corporate policy and
 * storage reasons that have nothing to do with this app. None of those are a
 * reason for a page to fail to render.
 */
export async function registerServiceWorker(
  container: ServiceWorkerContainer | undefined,
): Promise<ServiceWorkerRegistration | null> {
  if (!container) return null;
  try {
    return await container.register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE });
  } catch {
    return null;
  }
}

/** When the app noticed the waiting worker. */
export type UpdatePhase = "launch" | "session";

export type UpdateDisposition =
  /** Nothing to do. */
  | "none"
  /** Activate immediately, no toast (doc 41 section 7 step 4). */
  | "activate-now"
  /** Show the update toast and let the user choose (step 3). */
  | "offer";

export function updateDisposition(input: {
  readonly hasWaiting: boolean;
  readonly hasController: boolean;
  readonly phase: UpdatePhase;
}): UpdateDisposition {
  if (!input.hasWaiting) return "none";

  // Before the first interaction nothing is in flight, so asking would be a
  // dialog about nothing.
  if (input.phase === "launch") return "activate-now";

  // No controller means this is the first worker this origin has ever had. It
  // activates by itself and there is no older version to replace, so "a new
  // version is ready" would not be true.
  if (!input.hasController) return "none";

  return "offer";
}

/**
 * Tells the waiting worker to take over (doc 41 section 7 step 3).
 *
 * @returns whether there was a waiting worker to tell.
 */
export function postSkipWaiting(registration: ServiceWorkerRegistration): boolean {
  const waiting = registration.waiting;
  if (!waiting) return false;
  waiting.postMessage(SKIP_WAITING_MESSAGE);
  return true;
}

/**
 * Whether a `controllerchange` should reload the page.
 *
 * Two cases must not: the worker ships with `clientsClaim`, so the very first
 * worker claims the page that registered it and fires this with no old version
 * involved - a blank flash on a first visit for nothing. And the event can fire
 * more than once, where a second reload restarts a page that is already
 * restarting.
 */
export function shouldReloadOnControllerChange(input: {
  readonly hadControllerAtMount: boolean;
  readonly alreadyReloading: boolean;
}): boolean {
  return input.hadControllerAtMount && !input.alreadyReloading;
}
