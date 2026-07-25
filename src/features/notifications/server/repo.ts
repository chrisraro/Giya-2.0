import "server-only";

import { createClient } from "@/lib/supabase/server";

import { notificationRoute } from "../kinds";
import type { NotificationDTO } from "../types";

// The read half of doc 30-modules/30-platform-core.md section 5.6 and the whole
// data layer behind doc 33's `/notifications` inbox: the list, the unread badge
// count, and the two mark-read writes.
//
// EVERYTHING HERE RUNS AS THE CALLER, NOT AS THE SERVICE ROLE, and that is the
// point. 0026's fences are what make these functions correct:
//
//   * `notifications_owner_select` scopes every read to `user_id = auth.uid()`,
//     so a signed-in person cannot see another inbox no matter what this file
//     asks for;
//   * `notifications_owner_update` plus the column grant on `read_at` mean the
//     mark-read writes below are the ONLY writes any of this code could make,
//     even if it tried. There is no service-role client anywhere in this
//     module, so there is no path here that could rewrite a message.
//
// The `.eq("user_id", ...)` on every query is therefore belt and braces rather
// than the fence - but it is kept, for the reason receipts/server/repo.ts
// states at length: RLS is a UNION of policies, and the day a second select
// policy is added to this table (an admin support surface, say) a query relying
// on RLS alone silently widens. Constraining the tenancy key in the query means
// that day changes nothing here.

/** Doc 33: the inbox pages 25 at a time. One page is all any surface asks for
 * today, so pagination is a limit rather than a cursor until a screen needs
 * the second page. */
export const NOTIFICATION_PAGE_SIZE = 25;

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  data: unknown;
  business_id: string | null;
  read_at: string | null;
  created_at: string;
}

const NOTIFICATION_COLUMNS = "id, kind, title, body, data, business_id, read_at, created_at";

function toDTO(row: NotificationRow): NotificationDTO {
  return {
    id: row.id,
    // Left as the raw string when this build does not know the kind: a row
    // written by a newer deploy still renders, with the registry's fallback
    // icon, rather than being dropped or mislabelled.
    kind: row.kind,
    title: row.title,
    body: row.body,
    route: notificationRoute(row.data),
    businessId: row.business_id,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

/** The signed-in user's id, or null. Every function here needs it and none of
 * them may guess it. */
async function currentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/**
 * The inbox list, newest first.
 *
 * Served by `notifications_user_idx (user_id, created_at desc)`, which covers
 * the predicate and the ordering, so this is an index scan with no sort.
 *
 * Returns an empty list for a signed-out caller and for a read failure alike.
 * The page above renders an empty state either way; distinguishing them would
 * mean showing an error on a screen whose whole content is optional, and doc 30
 * section 5.6's error affordance is an inline retry, which a refresh already is.
 */
export async function listMyNotifications(
  limit = NOTIFICATION_PAGE_SIZE,
): Promise<NotificationDTO[]> {
  const userId = await currentUserId();
  if (userId === null) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notifications")
    .select(NOTIFICATION_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (error !== null) {
    console.error("[notifications/repo] could not list notifications", error);
    return [];
  }
  return (data as NotificationRow[] | null ?? []).map(toDTO);
}

/**
 * The badge number: how many of the caller's notifications are unread.
 *
 * `head: true` with an exact count sends no rows over the wire, which matters
 * because this runs on every page that renders the bell, not only when someone
 * opens the inbox. Served by the partial index
 * `notifications_user_unread_idx (user_id) where read_at is null`, which stays
 * roughly the size of one backlog rather than one history.
 *
 * ZERO ON FAILURE, deliberately, and the same call the business sidebar makes
 * for its review-queue badge: a badge is a number people act on, so a wrong
 * number is worse than no number, and no badge is what zero renders.
 */
export async function getMyUnreadNotificationCount(): Promise<number> {
  const userId = await currentUserId();
  if (userId === null) return 0;

  const supabase = await createClient();
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("read_at", null);

  if (error !== null) {
    console.error("[notifications/repo] could not count unread notifications", error);
    return 0;
  }
  return count ?? 0;
}

/**
 * Mark one notification read, and answer where it points.
 *
 * The route is read back from the ROW rather than accepted from the caller.
 * That is a security property, not tidiness: the inbox opens a notification by
 * posting its id, and taking the destination from the same form would make the
 * open handler an open redirect for anyone who can craft a POST. The stored
 * route has already been through `notificationRoute`'s shape check as well.
 *
 * `null` means "nothing was marked" - the id does not exist, or belongs to
 * someone else, which RLS renders indistinguishable and which is the correct
 * answer to both (doc 13's one 404).
 */
export async function markNotificationRead(
  notificationId: string,
): Promise<{ route: string | null } | null> {
  const userId = await currentUserId();
  if (userId === null) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("user_id", userId)
    // Only unread rows are written, so re-opening a read notification does not
    // move its timestamp: `read_at` means "when you first saw this", and the
    // 90-day retention sweep (doc 30 section 5.7) counts from it.
    .is("read_at", null)
    .select("data")
    .maybeSingle<{ data: unknown }>();

  if (error !== null) {
    console.error(
      `[notifications/repo] could not mark notification ${notificationId} read`,
      error,
    );
    return null;
  }
  if (data === null) {
    // Already read, or not the caller's. Fall back to reading the route so an
    // already-read row still opens where it points.
    return readRoute(notificationId, userId);
  }
  return { route: notificationRoute(data.data) };
}

async function readRoute(
  notificationId: string,
  userId: string,
): Promise<{ route: string | null } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notifications")
    .select("data")
    .eq("id", notificationId)
    .eq("user_id", userId)
    .maybeSingle<{ data: unknown }>();

  if (error !== null || data === null) return null;
  return { route: notificationRoute(data.data) };
}

/**
 * Mark every unread notification read. The "you are all caught up" action, and
 * the one doc 30 section 5.6 registers as the batch variant.
 *
 * Returns how many rows moved, so the caller can tell "nothing to do" from
 * "done" without a second count.
 */
export async function markAllNotificationsRead(): Promise<number> {
  const userId = await currentUserId();
  if (userId === null) return 0;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("read_at", null)
    .select("id");

  if (error !== null) {
    console.error("[notifications/repo] could not mark all notifications read", error);
    return 0;
  }
  return (data ?? []).length;
}
