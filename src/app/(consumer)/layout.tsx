import { redirect } from "next/navigation";

import { InstallPrompt } from "@/components/pwa/install-prompt";
import { OfflineBanner } from "@/components/pwa/offline-banner";
import { RegisterServiceWorker } from "@/components/pwa/register-service-worker";
import { BottomNav } from "@/components/shell/bottom-nav";
import { createClient } from "@/lib/supabase/server";

// The consumer shell, and the consumer onboarding gate.
//
// WHY THE GATE IS HERE AND NOT IN MIDDLEWARE
//
// `/onboarding` used to be reachable from exactly one place: destinationFor()
// on the signup page. Anyone who signed IN to an existing account that had
// never finished onboarding, and anyone who arrived through
// `/auth/callback` (whose `next` defaults to `/home`), skipped the wizard
// permanently and ended up on a home screen with no city and no interests.
//
// Answering "has this person onboarded?" needs `profiles.onboarded_at`, which
// is a table read. Middleware runs on every matched request in the app,
// including the marketing site, the business portal and every asset the
// matcher does not exclude, so a database round trip there is paid by traffic
// that could never care about the answer. A layout is the cheaper and more
// precise place: it runs only for the segments underneath it, it is a server
// component so the read never reaches the client, and it is the pattern this
// codebase already chose for the equivalent business-side question - see
// `(business)/business/(portal)/layout.tsx`, which queries `business_staff`
// in the layout and leaves middleware to the session-only check.
//
// TWO DELIBERATE LIMITS OF PUTTING IT IN THIS LAYOUT
//
//  1. Layouts do not receive the pathname, so the gate cannot exempt
//     individual children. That includes `/b/[slug]`, the public business
//     page, which also lives in this group. It stays public in the sense that
//     matters: the gate only fires for a signed-IN user, so a signed-out
//     visitor following a shared shop link is never touched. A signed-in user
//     who has not finished a four-step wizard is asked to finish it once, and
//     every later visit resolves normally.
//  2. Everyone gets a `consumers` row at signup (private.handle_new_user), so
//     "un-onboarded" here also matches a business owner who wandered onto a
//     consumer screen. They get the consumer wizard once and are then done.
//     Distinguishing them would cost a second query on every consumer page to
//     save a one-time, skippable four-step flow, which is not a trade worth
//     making.
//
// The gate depends on `/onboarding` ALWAYS stamping `onboarded_at`, including
// via "Skip for now" - otherwise this redirect and that screen's exit would
// bounce a user back and forth forever. See the note on handleSkip in
// `(auth)/onboarding/page.tsx`.
export default async function ConsumerLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    // RLS profiles_owner_select scopes this to the caller's own row, so no
    // explicit user filter is needed for correctness; `.eq` is kept anyway so
    // the query says what it means and stays correct if a broader policy is
    // ever added.
    const { data: profile } = await supabase
      .from("profiles")
      .select("onboarded_at, is_suspended")
      .eq("id", user.id)
      .maybeSingle();

    // Doc 30 section 2.8: a suspended consumer is redirected to a terminal
    // screen for every authenticated route under this layout. Checked BEFORE
    // onboarding and with no read-failure escape hatch of its own (a `null`
    // profile just skips this branch and falls through to the onboarding
    // check below, whose own transient-error reasoning already covers it) -
    // unlike onboarding, this redirect is a courtesy, not the control: the
    // money paths (claimReward, submitReceipt, validateRedemption) refuse
    // independently via src/lib/auth/suspension.ts's fail-CLOSED readers, so
    // a missed redirect here from a transient blip cannot let a suspended
    // consumer actually transact - it would just see one more screen before
    // hitting a real refusal. See src/middleware.ts's header for why this
    // lives in a layout at all rather than middleware.
    if (profile && profile.is_suspended) {
      redirect("/suspended?type=account");
    }

    // A read failure yields `profile === null`, which is treated as "not
    // onboarded" only when a row genuinely came back without a stamp. A null
    // ROW means the read failed or the profile is missing, and bouncing
    // someone into onboarding on a transient error would be worse than
    // letting them through: onboarding is a preference collector, not a
    // security boundary.
    if (profile && profile.onboarded_at === null) {
      redirect("/onboarding");
    }
  }

  return (
    <div className="min-h-dvh bg-surface pb-24">
      {children}
      <BottomNav />
      {/*
        The ONLY service worker registration in the app. Doc 41's preamble
        excludes the business and admin portals from SW scope: staff decisions
        (redemption validation, review queues) must never be made against a
        cached page, and a back-office terminal is shared by a whole shift.
        Mounted here rather than in the root layout, which also wraps those
        portals plus the marketing site. src/app/service-worker-scope.test.ts
        holds that line.
      */}
      <RegisterServiceWorker />
      {/*
        Doc 41 section 9's ONE global offline pill. Same layout and the same
        reason as the registration above: the business and admin portals are
        not offline-capable surfaces and must not grow an offline affordance
        that implies they are. It renders nothing while the connection is up,
        so mounting it unconditionally costs a signed-out visitor on /b/[slug]
        nothing. src/app/offline-ui-scope.test.ts holds the portal line.
      */}
      <OfflineBanner />
      {/*
        The install offer (doc 41 section 2). Mounted HERE rather than on the
        receipt screen that triggers it, and that is not tidiness:
        `beforeinstallprompt` fires on page load, and a client-side navigation
        into /scan/[receiptId] is not a page load, so a listener attached at
        the trigger site would never have an event to replay. It renders
        nothing until a receipt of theirs reaches `approved`.
      */}
      <InstallPrompt />
    </div>
  );
}
