"use client";

import * as React from "react";

import { forgetActiveUser } from "@/features/pwa/active-user";
import { signOut } from "@/features/identity/actions";
import { postUserCachePurge } from "@/lib/pwa/logout-purge";

/**
 * The Log out control, everywhere in the app (doc 41 preamble rule 2).
 *
 * WHY THIS EXISTS AT ALL, GIVEN `<form action={signOut}>` ALREADY WORKED.
 *
 * `giya-pages-*` holds RSC-rendered documents, and on this app those documents
 * carry the signed-in consumer's name, points balance and claims IN THE HTML.
 * Doc 41's preamble says caches are purged on deploy and on logout; only the
 * deploy half shipped. Without the purge, consumer A logs out on a shared phone,
 * consumer B signs in, B opens /home on a slow link, the pages route's 3-second
 * NetworkFirst timeout fires, and the worker serves A's document.
 *
 * The purge has to be posted from the CLIENT - `postMessage` to a service worker
 * does not exist in a Server Action - so this thin client component wraps the
 * server action rather than the action doing it itself. Shared devices are the
 * norm in this market, so every logout in the app goes through here: the
 * consumer profile, the suspended screen, the admin shell, and the "revoke the
 * device I am holding" path in the device list, which calls `postUserCachePurge`
 * directly for the same reason.
 *
 * TWO THINGS THIS MUST NEVER DO, both of which are pinned in logout-form.test.tsx:
 *
 *  1. STRAND THE CONSUMER SIGNED IN. `postUserCachePurge` never throws and is
 *     never awaited, so no browser state - no worker, no controller, storage
 *     blocked, a post that throws - can stop the sign-out that follows it. A
 *     logout that failed because a cache could not be cleared would be worse
 *     than the bug being fixed.
 *  2. SWALLOW THE REDIRECT. `signOut()` ends in `redirect("/login")`, which
 *     signals by throwing, so the call sits outside any try/catch here. There is
 *     deliberately no error handling around it.
 */
/**
 * The client action the form runs. Exported so it can be tested by EXECUTION.
 *
 * Rendering the form and clicking the button proves the purge is posted and the
 * action is called, but not the second property above: React's form machinery
 * absorbs whatever this function throws, so a mutant that wrapped `signOut()` in
 * a `try/catch` looked identical through the DOM while, in production, having
 * swallowed the redirect and left the consumer on a page that still says their
 * name. Calling this directly makes that observable - the promise must REJECT.
 */
export async function logOutAction(): Promise<void> {
  // BEFORE the action, and synchronously. Once `signOut()` resolves the session
  // is gone and the navigation to /login is under way; a purge posted after
  // that races a page that may already be unloading.
  postUserCachePurge(typeof navigator === "undefined" ? undefined : navigator.serviceWorker);

  // And forget who was signed in, so the Background Sync replay - which runs
  // with the app closed and has no session - drains nothing until somebody
  // opens a consumer page again. See src/features/pwa/active-user.ts.
  //
  // NOT AWAITED, on purpose and for the same reason as the purge: this is
  // storage, storage can be blocked or slow, and nothing on the way out of a
  // session may be able to hold the consumer inside it. The write is issued
  // synchronously and the navigation to /login is a soft one, so the
  // transaction completes; and a record that survives is bounded, because the
  // session it names is already gone and a drain under it can only 401, which
  // the replay pauses on without spending an attempt.
  void forgetActiveUser();

  // Bare, and it stays bare. See the note above about redirect().
  await signOut();
}

export function LogoutForm({
  className,
  children,
}: {
  readonly className?: string | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <form action={logOutAction} className={className}>
      {children}
    </form>
  );
}
