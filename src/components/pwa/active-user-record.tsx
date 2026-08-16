"use client";

import * as React from "react";

import { rememberActiveUser } from "@/features/pwa/active-user";

/**
 * Records who is signed in, where the service worker can read it.
 *
 * RENDERS NOTHING, and it is not decoration. `src/app/sw.ts`'s Background Sync
 * replay runs with the app closed and has no session of its own; without this
 * record it would have to drain every row on the device, and on a shared phone
 * that means submitting the previous consumer's receipt under the current one's
 * session - a 403 the replay treats as terminal, which deletes it. See
 * `src/features/pwa/active-user.ts` for the whole argument, including why doc
 * 41's `SET_USER` message cannot do this job.
 *
 * MOUNTED IN THE CONSUMER LAYOUT rather than on /scan, so the record is current
 * from the first page a consumer opens. The gap that closes is real: B signs
 * in, lands on /home, never opens /scan, and a `sync` event fires against A's
 * leftover rows.
 *
 * The write is fire-and-forget and cannot fail visibly: `rememberActiveUser`
 * resolves `false` rather than throwing on a browser with no IndexedDB, and a
 * missing record only means the next background drain does nothing.
 */
export function ActiveUserRecord({ userId }: { readonly userId: string }) {
  React.useEffect(() => {
    void rememberActiveUser(userId);
  }, [userId]);

  return null;
}
