import "server-only";

import { getServerEnv } from "@/lib/env";
import { renderEmail } from "@/lib/email/render";
import { sendEmail } from "@/lib/email/send";

import type { BusinessRole } from "../../server/resolve-owner-business";

// ===========================================================================
// WHY THIS CALLS sendEmail() DIRECTLY, NOT THROUGH notifications/kind
// 'staff_invite'
// ===========================================================================
// Doc 30 section 5.3 reserves `staff_invite` as a kind name and doc 30's
// platform-core kinds.ts registry (src/features/notifications/kinds.ts) lists
// it in a comment as "remain[ing] reserved... for the slices that will raise
// [it]" - but the DATABASE constraint on `notifications.kind`
// (0026_notifications.sql) does not yet name it, only the five kinds already
// shipped. Adding it would be a migration, and this task's brief is explicit
// that a migration means STOP ("another task owns the sequence").
//
// Even with that constraint widened, the SAME wall task 2.5 documented in
// src/lib/alerts/job-health.ts applies here, one level worse:
// `notifications.user_id` is `not null references profiles(id)` (0026). Every
// invite THIS module raises for an email with no prior Giya account gets a
// freshly-minted `user_id` (server/service.ts's `resolveInviteeUserId`
// creates the auth user), so technically a `profiles` row always exists by
// the time this runs (0003's `handle_new_user` trigger fires on auth.users
// insert) - but that profile is for an account nobody has ever confirmed
// ownership of, and routing the ONLY notice of its existence through the
// in-app inbox `notifications` feeds would mean the message lives somewhere
// only reachable by signing in - which is exactly what the invitee cannot yet
// do. The email IS the invite; it cannot be a courtesy copy of an in-app
// message the recipient has no way to see.
//
// So: `sendEmail()` directly, addressed to the literal `invited_email`
// string, exactly the shape job-health.ts's header argues for and
// src/lib/email/send.ts's own header names as the second caller this file's
// comment anticipated. Still exactly one Resend integration, one send, one
// contract - a second CALLER, never a second implementation.
// ===========================================================================

/** Doc 30 section 2.5: `APP_ORIGIN` then `QSTASH_CALLBACK_ORIGIN`, same
 * fallback order and same reasoning as src/workers/notify/email.ts's own
 * `resolveOrigin` - cloned rather than imported because that function is not
 * exported, and it is small enough that cloning it here (rather than lifting
 * it to a shared module neither slice asked for) does not cost much. See
 * that module for why the two keys exist separately. */
export function resolveOrigin(): string | null {
  try {
    const env = getServerEnv();
    return env.APP_ORIGIN ?? env.QSTASH_CALLBACK_ORIGIN ?? null;
  } catch {
    return null;
  }
}

const ROLE_LABEL: Record<BusinessRole, string> = {
  owner: "owner",
  manager: "manager",
  marketing: "marketing",
  staff: "staff",
};

export interface StaffInviteEmailInput {
  readonly to: string;
  readonly businessName: string;
  readonly role: BusinessRole;
  readonly token: string;
  /**
   * Set only when `resolveInviteeUserId` had to mint a brand-new account for
   * this email (no prior Giya account existed). Null means the invitee
   * already has an account and can simply sign in normally. See
   * server/service.ts's header for the account-resolution decision this
   * flows from.
   */
  readonly newAccountSetupLink: string | null;
}

/**
 * Sends the `staff_invite` email. NEVER THROWS - matches `sendEmail`'s own
 * contract - and the caller (service.ts's `inviteStaff`) treats this as
 * best-effort exactly the way `receipts/server/notify.ts` and every other
 * in-app-notification raiser in this codebase treats the SEND as separate
 * from the STATE CHANGE it is announcing: the invite row is the source of
 * truth, the email is a courtesy that a mail provider or a typo can still
 * legitimately fail to deliver, and losing it must not make the whole invite
 * un-issuable (the roster still shows the pending row, and the owner can
 * resend).
 */
export async function sendStaffInviteEmail(input: StaffInviteEmailInput): Promise<void> {
  const origin = resolveOrigin();
  const inviteHref = `/invite/${input.token}`;

  // The setup link is a RAW URL folded into the body text, not a second
  // `action` - `renderEmail`'s `EmailCopy` carries exactly one action link by
  // design (its header: "the ONE next step, when there is an honest one"),
  // and this message genuinely has two different next steps for the two
  // audiences it is sent to. Inlining Supabase's own link as plain text
  // keeps it real and clickable in every mail client without asking
  // render.ts to grow a second action slot for one caller.
  const setupLine =
    input.newAccountSetupLink !== null
      ? ` This email has no Giya account yet - set one up first: ${input.newAccountSetupLink}`
      : "";

  const rendered = renderEmail({
    origin,
    businessName: input.businessName,
    copy: {
      title: `You've been invited to join ${input.businessName} on Giya`,
      body:
        `${input.businessName} invited you to join their Giya business portal as ${roleLabel(input.role)}.` +
        setupLine,
      action: { label: "Review the invite", href: inviteHref },
    },
  });

  const result = await sendEmail({
    to: input.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  if (!result.ok) {
    console.error(
      `[businesses/staff/notify] staff_invite send to ${input.to} failed: ${result.reason}`,
    );
  }
}

function roleLabel(role: BusinessRole): string {
  return ROLE_LABEL[role] ?? role;
}
