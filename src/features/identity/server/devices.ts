import { headers } from "next/headers";

import { relativeTime } from "@/features/analytics/metrics";
import { createClient } from "@/lib/supabase/server";

import { describeUserAgent } from "../user-agent";

// ===========================================================================
// public.user_devices, which was entirely dead until this slice.
//
// The table, its RLS policy `user_devices_owner_all`, its partial index
// `where is_revoked = false` and a `receipts.device_id` foreign key have all
// existed since 0002 and 0017. `grep` across src/ returned zero references:
// no writer, no reader. Nobody's device was ever registered.
//
// ---------------------------------------------------------------------------
// WHAT COUNTS AS "THE SAME DEVICE": (user_id, platform, user_agent)
// ---------------------------------------------------------------------------
//
// This is the real decision in this file, so it is written down rather than
// implied. `user_devices` has exactly ONE unique key, `fcm_token`, and this
// slice does not build push - that is Wave 7 - so every row written here has a
// null token and the unique key constrains nothing. Something else has to answer
// "is this the same device signing in again?", and if nothing does, every
// sign-in appends a row and the device list degenerates into a login log.
//
// The candidates, and why the others lose:
//
//   * A SESSION ID changes on every token refresh, so the same browser would
//     produce a new row every hour.
//   * AN IP ADDRESS changes between mobile data and wifi, and is shared by
//     everyone behind a CGNAT - which in the Philippines is most mobile
//     traffic. It both splits one device and merges two.
//   * A CLIENT-GENERATED ID in localStorage would be exact, but it is cleared
//     by "clear browsing data", it is absent on the very first request (which
//     is a server round trip, before any client code has run), and it needs a
//     migration to store. This slice writes no SQL.
//
// The user agent is the only identity that is stable ACROSS sessions and
// distinct BETWEEN browsers, and it arrives on the request that establishes the
// session, so nothing has to be plumbed to the client.
//
// ITS TWO COSTS, ACCEPTED KNOWINGLY:
//
//   1. Two identical browser builds on two identical machines collapse into one
//      row. One list entry where there should be two is a worse-informed list;
//      an unbounded pile of duplicates is an unusable one. Collapsing loses
//      less.
//   2. A browser upgrade changes the version string, so an upgraded browser
//      appears as a NEW device. That is arguably correct - it is a new client
//      build - and the superseded row ages out visibly by `last_seen_at`
//      instead of silently.
//
// RACE: read-then-write, with NO unique index behind it, because adding one
// needs a migration and this task writes none. Two sign-ins landing in the same
// instant can both miss the read and both insert. The result is a duplicate row,
// not corruption; the next sign-in updates whichever one it finds, and the other
// ages out. If this ever matters enough to fix, the fix is a partial unique
// index on (user_id, platform, user_agent) and an upsert - a migration, and a
// deliberate one.
//
// One visible consequence of that race, stated here so it is not mistaken for a
// separate bug: duplicate rows share a user agent, so `listMyDevices` would badge
// BOTH of them "This device". The badge is computed from the identity, and
// duplicates are by definition the same identity.
//
// `is_revoked` IS NEVER WRITTEN HERE. Revoking is a DELETE - see deleteDevice.
// ===========================================================================

/**
 * The only platform this slice writes. `user_devices.platform` is checked
 * against ('web','android','ios'); the native clients are not built yet, and
 * writing 'web' from a browser is the honest value rather than a placeholder.
 */
const WEB_PLATFORM = "web";

/**
 * A user agent is a caller-controlled, unbounded header and `user_agent` is
 * `text`. Storing 40KB of someone's header per sign-in is a cost with no
 * benefit; real user agents run to about 180 characters.
 *
 * CRITICAL: the truncation happens in ONE place and is applied to the lookup as
 * well as the write. Truncating on write only would mean the row is never found
 * again, and a new row would be appended on every single sign-in - the exact
 * failure this module exists to prevent.
 */
const USER_AGENT_MAX_LENGTH = 400;

function deviceIdentity(userAgent: string): string {
  return userAgent.slice(0, USER_AGENT_MAX_LENGTH);
}

/** The current request's user agent, or null when it carries none. */
async function currentUserAgent(): Promise<string | null> {
  const requestHeaders = await headers();
  const raw = requestHeaders.get("user-agent");
  // `||` and not `??`: an empty header is no identity, same as an absent one.
  return raw ? deviceIdentity(raw) : null;
}

export interface DeviceDTO {
  id: string;
  /** "Chrome on Windows". Never the raw user agent - see user-agent.ts. */
  summary: string;
  /** "2 days ago". Coarse on purpose; the page is server-rendered. */
  lastSeen: string;
  /** True for the device this very request came from. */
  isCurrent: boolean;
}

export type DeviceListResult = { ok: true; devices: DeviceDTO[] } | { ok: false };

export type DeviceDeleteResult = { ok: true; wasCurrent: boolean } | { ok: false };

/**
 * Records that this browser has an active session, or refreshes the record it
 * already has.
 *
 * CALLED ON THE SIGN-IN PATH, so it never throws and never returns a failure:
 * a device row that could not be written is not a reason to fail somebody's
 * login, and there is nothing for them to do about it if it were. Everything
 * that goes wrong is logged and swallowed.
 *
 * `fcm_token` is deliberately left unset. It is `unique`, so writing any
 * placeholder into it would make the SECOND consumer to register collide with
 * the first. Wave 7 owns it.
 */
export async function registerDevice(): Promise<void> {
  const userAgent = await currentUserAgent();
  // No user agent means no identity, and registering without one would append
  // one more indistinguishable row on every sign-in. Registering nothing is the
  // honest outcome: the consumer sees no device rather than a growing pile of
  // devices none of which they can recognise.
  if (userAgent === null) return;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return;

  const seenAt = new Date().toISOString();

  const { data: existing, error: lookupError } = await supabase
    .from("user_devices")
    .select("id")
    .eq("user_id", user.id)
    .eq("platform", WEB_PLATFORM)
    .eq("user_agent", userAgent)
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    // Deliberately NOT falling through to the insert. A transient lookup
    // failure that inserts anyway is how one blip becomes a permanent duplicate
    // row in somebody's device list.
    console.error("[identity] device lookup failed", lookupError);
    return;
  }

  if (existing) {
    const { error } = await supabase
      .from("user_devices")
      .update({ last_seen_at: seenAt })
      .eq("id", existing.id);
    if (error) console.error("[identity] device last_seen_at update failed", error);
    return;
  }

  const { error } = await supabase.from("user_devices").insert({
    user_id: user.id,
    platform: WEB_PLATFORM,
    user_agent: userAgent,
    last_seen_at: seenAt,
  });
  if (error) console.error("[identity] device registration failed", error);
}

/**
 * The caller's devices, newest first, or a failure.
 *
 * `{ ok: true, devices: [] }` and `{ ok: false }` are different answers and the
 * screen renders them differently. A consumer with no registered devices and a
 * consumer whose query timed out must never see the same page: "no devices"
 * reads as "nothing is signed in anywhere", which is a claim about their
 * account's security that a failed read has no business making.
 */
export async function listMyDevices(now: Date = new Date()): Promise<DeviceListResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { ok: false };

  const userAgent = await currentUserAgent();

  const { data, error } = await supabase
    .from("user_devices")
    .select("id, platform, user_agent, last_seen_at")
    .eq("user_id", user.id)
    .order("last_seen_at", { ascending: false });

  if (error !== null || data === null) return { ok: false };

  return {
    ok: true,
    devices: data.map((row) => ({
      id: row.id,
      summary: describeUserAgent(row.user_agent),
      lastSeen: relativeTime(new Date(row.last_seen_at), now),
      isCurrent: userAgent !== null && row.platform === WEB_PLATFORM && row.user_agent === userAgent,
    })),
  };
}

/**
 * Removes one device. THE ROW IS DELETED, not flagged.
 *
 * That is the schema's own design, not a shortcut: 0017_receipts.sql declares
 * `device_id uuid references public.user_devices(id) on delete set null` and its
 * comment says why - "so a consumer can delete a device at any time". Receipts
 * that pointed at the device survive with a null pointer; the fraud signals they
 * produced are kept regardless.
 *
 * `is_revoked` is NOT used. It exists in 0002 and is read by nothing in this
 * codebase, so setting it would look like a revoke while leaving the row in the
 * list and in every foreign key that references it - a control that appears to
 * work and does not.
 *
 * `wasCurrent` is returned rather than acted on here, because what to do about
 * it is a product decision belonging to the action: see revokeDevice in
 * actions.ts, which turns it into a real sign-out.
 */
export async function deleteDevice(deviceId: string): Promise<DeviceDeleteResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { ok: false };

  const userAgent = await currentUserAgent();

  // Read first, because after the delete there is nothing left to compare the
  // current request against.
  const { data: row, error: lookupError } = await supabase
    .from("user_devices")
    .select("user_agent, platform")
    .eq("id", deviceId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (lookupError !== null || row === null) {
    if (lookupError) console.error("[identity] device lookup before delete failed", lookupError);
    return { ok: false };
  }

  const wasCurrent =
    userAgent !== null && row.platform === WEB_PLATFORM && row.user_agent === userAgent;

  // `.eq("user_id")` as well as `.eq("id")`: RLS user_devices_owner_all is the
  // real gate, same convention as every repo here, but a delete is the one
  // statement where saying what you mean is worth the extra predicate.
  const { error } = await supabase
    .from("user_devices")
    .delete()
    .eq("id", deviceId)
    .eq("user_id", user.id);

  if (error) {
    console.error("[identity] device delete failed", error);
    return { ok: false };
  }

  return { ok: true, wasCurrent };
}
