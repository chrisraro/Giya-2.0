import type { MetaConnectionCapability, MetaSurfaceState } from "./types";

// =============================================================================
// THE DEGRADED-STATE SENTENCES, IN ONE PLACE, FOR BOTH SURFACES.
// =============================================================================
//
// Every string below is a CLAIM ABOUT WHY A MERCHANT CANNOT SEE OR DO
// SOMETHING, made on a screen they take decisions from. They live here rather
// than inline in the components for one reason that is not tidiness: the
// campaign composer explains the state, and the server action refuses with a
// message, and those two have to agree. A merchant told "this needs a
// permission we do not have yet" who then presses a button and is told "could
// not publish" has been given two different stories about one fact.
//
// No server imports. The components are client components and the action is
// server-only; both read from here.
//
// -----------------------------------------------------------------------------
// THE RULES THESE SENTENCES FOLLOW
// -----------------------------------------------------------------------------
//
// 1. NEVER ACCUSE THE MERCHANT. Nothing here is their fault, and only two of
//    these states are even actionable by them.
// 2. NEVER IMPLY A FIX THAT DOES NOT EXIST. `scope_missing` is the important
//    one: while the Meta app is unreviewed, an ordinary merchant CANNOT obtain
//    `pages_manage_posts` by reconnecting, however many times they try. Telling
//    them to reconnect would be a lie with a button attached. Same for
//    `unreadable`, which is a key-management problem on our side.
// 3. NEVER SAY "ERROR" FOR SOMETHING THAT IS SIMPLY NOT SWITCHED ON. The
//    connection card already sets this precedent and these follow it.
// 4. NEVER PROMISE AN ACTION WE HAVE NOT TAKEN. An earlier draft of the
//    `unreadable` copy said support had been notified. Nothing notifies
//    support, so it does not say that any more.

/** Fixed prose for the deployment-wide states, on the ANALYTICS surface. */
export const INSIGHTS_SURFACE_COPY: Record<Exclude<MetaSurfaceState, "pages">, string> = {
  not_configured: "Audience and engagement figures are not available on this deployment yet.",
  storage_unavailable:
    "Audience and engagement figures are not available yet: secure credential storage is not configured.",
  not_connected: "Connect a Facebook Page in Settings to see your audience and engagement figures.",
};

/** Fixed prose for one Page's token, on the ANALYTICS surface. */
export const INSIGHTS_PAGE_COPY: Record<Exclude<MetaConnectionCapability, "ready">, string> = {
  needs_reconnect:
    "The access we were given has ended. Reconnect this Page in Settings to bring these figures back.",
  scope_missing:
    "This Page's access does not include permission to read insights, so there are no figures to show.",
  unavailable: "Facebook is not responding right now. These figures will come back on their own.",
  unreadable:
    "Giya cannot open the stored credential for this Page. This one is ours to fix, and reconnecting will not help.",
};

/** Fixed prose for the deployment-wide states, on the PUBLISHING surface. */
export const PUBLISH_SURFACE_COPY: Record<Exclude<MetaSurfaceState, "pages">, string> = {
  not_configured: "Posting to a Facebook Page is not available on this deployment yet.",
  storage_unavailable:
    "Posting to a Facebook Page is not available yet: secure credential storage is not configured.",
  not_connected: "Connect a Facebook Page in Settings before posting a campaign announcement.",
};

/** Fixed prose for one Page's token, on the PUBLISHING surface. */
export const PUBLISH_PAGE_COPY: Record<Exclude<MetaConnectionCapability, "ready">, string> = {
  needs_reconnect:
    "The access we were given has ended. Reconnect this Page in Settings before posting.",
  // THE SENTENCE THIS WHOLE SLICE EXISTS TO GET RIGHT. It says what is true:
  // the permission has not been approved for this app yet. It does not blame
  // the merchant, and it does not send them off to reconnect, because for
  // anyone who is not an app admin, developer or tester of the Meta app,
  // reconnecting will produce exactly the same result.
  scope_missing:
    "Posting needs a Facebook permission this app has not been approved for yet. Nothing is wrong with your Page or your account.",
  unavailable:
    "Facebook is not responding right now, so posting is paused. Please try again in a few minutes.",
  unreadable:
    "Giya cannot open the stored credential for this Page. This one is ours to fix, and reconnecting will not help.",
};

/** What a tile says instead of a number Meta never reported. Never a zero. */
export const TILE_UNREPORTED_LABEL = "Not reported";

/** The window the analytics tiles describe. Matches the client's `days_28`. */
export const INSIGHTS_PERIOD_LABEL = "Last 28 days";
