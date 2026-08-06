import Link from "next/link";

import { EmptyState } from "@/components/consumer/empty-state";
import { InviteAccept } from "@/features/businesses/staff/components/invite-accept";
import { previewInvite } from "@/features/businesses/staff/server/service";
import { createClient } from "@/lib/supabase/server";

// /invite/[token] - staff invite acceptance (doc 30 section 2.7, doc 32
// section 7.1). Top-level route, deliberately OUTSIDE both `(business)` and
// `(auth)` - the invitee is by definition not yet staff of any tenant (so the
// `(business)` layout's membership check would refuse them), and `(auth)` is
// off limits to this task (another task owns it, building password reset
// there). `src/middleware.ts`'s session gate only fires for
// `/business/*`, the seven listed consumer routes, and `/onboarding*` - this
// path matches none of those, so it renders for a signed-out visitor exactly
// as it must for the "no account yet" case doc 30 describes.
//
// READ (this page) vs WRITE (<InviteAccept>): see server/service.ts's
// `previewInvite` header. This page NEVER calls the mutating `acceptInvite` -
// only a click inside `<InviteAccept>` does, which Next sends as a POST
// regardless of how this page was reached.
export const dynamic = "force-dynamic";

type PageParams = { token: string };

function loginHref(token: string): string {
  return `/login?next=${encodeURIComponent(`/invite/${token}`)}`;
}

// NOT `?next=...` (review fix I6). `/login` reads and honours `next`
// (src/app/(auth)/login/page.tsx: `getSafeRedirect(searchParams.get("next"),
// ...)`), so `loginHref` above genuinely round-trips. `/signup` does not -
// it computes its own post-signup destination from the chosen role
// (`destinationFor(role)`) and never reads a `next` param at all. Carrying
// one here would be a dead affordance: a query string that looks like a
// promise and does nothing. `(auth)` is off-limits to this task (another
// task is building password reset there), so the honest fix is the on-page
// copy below telling the invitee to come back to THIS link once they have
// an account, rather than a param claiming a round trip that doesn't exist.
// Wiring `next` through `/signup` is real, tracked follow-up work for
// whichever task next touches `(auth)`.
const SIGNUP_HREF = "/signup";

export default async function InviteAcceptPage({ params }: { params: Promise<PageParams> }) {
  const { token } = await params;

  const preview = await previewInvite(token);

  if (!preview.ok) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 py-16">
        <EmptyState
          icon="link_off"
          title={preview.code === "INVITE_EXPIRED" ? "This invite has expired" : "This invite link isn't valid"}
          body={preview.message}
        />
      </main>
    );
  }
  if (!preview.data) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 py-16">
        <EmptyState icon="error" title="Could not load this invite" body="Refresh to try again." />
      </main>
    );
  }

  const { businessName, role, invitedEmail } = preview.data;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-16">
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-headline-s text-on-surface">You&apos;re invited to join {businessName}</h1>
        <p className="text-body-m text-on-surface-variant">
          {invitedEmail ? `${invitedEmail} - ` : ""}
          {role} on Giya.
        </p>
      </div>

      {user === null ? (
        <div className="flex flex-col gap-3 text-center">
          <p className="text-body-s text-on-surface-variant">
            {invitedEmail
              ? `Sign in as ${invitedEmail} to accept this invite, or create an account with that address.`
              : "Sign in to accept this invite."}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Link
              href={loginHref(token)}
              className="inline-flex h-12 items-center justify-center rounded-full bg-primary px-6 text-label-l text-on-primary"
            >
              Sign in
            </Link>
            <Link
              href={SIGNUP_HREF}
              className="inline-flex h-12 items-center justify-center rounded-full border border-outline px-6 text-label-l text-primary"
            >
              Create account
            </Link>
          </div>
          {/* Honest hand-off (review fix I6): creating an account does NOT
              return here automatically - see SIGNUP_HREF's comment. */}
          <p className="text-body-s text-on-surface-variant">
            After creating your account, come back to this link (or the one in
            your invite email) to finish accepting.
          </p>
        </div>
      ) : /* UX HINT ONLY, not the security boundary: compares email because
             that is all this render has cheaply in hand. The actual check
             (service.ts's `acceptInvite`, matching `sessionUserId` against
             the row's real `user_id`) is what <InviteAccept> ultimately hits
             on click and is authoritative regardless of what renders here -
             "UI hiding is cosmetic" applies to this branch same as anywhere
             else in the portal. */
      invitedEmail !== null && user.email !== invitedEmail ? (
        <div className="flex flex-col gap-3 text-center">
          <p role="alert" className="text-body-s text-error">
            You&apos;re signed in as {user.email}. This invite was sent to {invitedEmail}. Sign
            out and sign in as that account to accept it.
          </p>
          <Link
            href={loginHref(token)}
            className="inline-flex h-12 items-center justify-center rounded-full border border-outline px-6 text-label-l text-primary"
          >
            Switch account
          </Link>
        </div>
      ) : (
        <InviteAccept token={token} />
      )}
    </main>
  );
}
