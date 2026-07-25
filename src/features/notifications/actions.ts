"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { markAllNotificationsRead, markNotificationRead } from "./server/repo";

// The two writes the inbox can make, as Server Actions posted from plain
// forms.
//
// WHY FORMS AND NOT A CLIENT ISLAND. Doc 33's rule is RSC-first with islands
// only where interaction demands one, and neither of these demands one: both
// are "submit one id and navigate", which is what a form has always been. The
// result is that /notifications ships zero client JavaScript, works with JS
// disabled, and - the part that actually matters here - marking read happens on
// the SERVER before the redirect, so a consumer can never end up on the deep
// link with the notification still bold. A client island firing the mutation
// and navigating in parallel would race exactly that.
//
// THE ROUTE IS NOT ACCEPTED FROM THE FORM. `openNotification` posts an id and
// nothing else; the destination is read back off the row inside
// `markNotificationRead`, under RLS. Taking a `route` field from the request
// would make this action an open redirect for anyone who can craft a POST
// against a URL a consumer has every reason to trust.

const INBOX = "/notifications";

/**
 * Open one notification: mark it read, then send the caller where it points.
 *
 * A missing id, someone else's id, or a notification with no deep link all
 * land back on the inbox. The three are deliberately indistinguishable from
 * the outside (doc 13's one 404): an inbox that answers "that one is not
 * yours" differently from "that one does not exist" enumerates other people's
 * notification ids.
 */
export async function openNotification(formData: FormData): Promise<void> {
  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) redirect(INBOX);

  const result = await markNotificationRead(id);

  // Revalidate before redirecting so the badge is right whichever way the
  // consumer goes next, including straight back.
  revalidatePath(INBOX);
  revalidatePath("/home");
  revalidatePath("/profile");

  redirect(result?.route ?? INBOX);
}

/**
 * "Mark all read", doc 30 section 5.6's batch variant. Stays on the inbox: the
 * point of the button is to watch the list go quiet.
 */
export async function markAllNotificationsReadAction(): Promise<void> {
  await markAllNotificationsRead();
  revalidatePath(INBOX);
  revalidatePath("/home");
  revalidatePath("/profile");
}
