import type { Metadata } from "next";

import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { signOut } from "@/features/identity/actions";

// Doc 30 section 2.8: "/suspended | Suspension notice | [MVP] | Terminal
// screen, logout only". Reached from the consumer layout's and the business
// portal layout's suspension gates (src/app/(consumer)/layout.tsx,
// src/app/(business)/business/(portal)/layout.tsx), never linked to directly.
//
// WHAT THIS PAGE DELIBERATELY DOES NOT DO: read `profiles.suspended_reason`
// or `businesses.suspended_reason`. Both are free text an ADMIN typed for the
// audit log (src/features/admin/consequences.ts's header: "written from the
// SAME string" as `audit_logs.reason`) - internal, operator-facing, and never
// written with an end user as its audience. Echoing it verbatim here would
// hand a suspended person whatever an admin happened to type, unfiltered,
// which is a disclosure risk this screen has no business taking. Instead the
// two callers pass only `?type=account|business` (never the reason itself),
// and this page shows one fixed, reviewed sentence per type plus a real path
// to a human: an appeal contact. "How to appeal" is satisfied by that
// contact, not by narrating the reason back.
//
// "Logout only": the one action on this screen besides the appeal link is
// signing out, via the same <form action={signOut}> pattern
// src/app/(consumer)/profile/page.tsx uses (a plain server-action form, no
// client island needed).

export const metadata: Metadata = { title: "Account suspended · Giya" };

const SUPPORT_EMAIL = "teamocsph@gmail.com";

type SuspensionType = "account" | "business";

const COPY: Record<SuspensionType, { title: string; body: string; subject: string }> = {
  account: {
    title: "Your account is suspended",
    body: "You can no longer scan receipts, claim rewards, or redeem points while your account is suspended.",
    subject: "Appeal my Giya account suspension",
  },
  business: {
    title: "This business is suspended",
    body: "Your team can no longer access the merchant portal or redeem rewards for customers while this business is suspended.",
    subject: "Appeal my Giya business suspension",
  },
};

function resolveSuspensionType(raw: string | string[] | undefined): SuspensionType {
  return raw === "business" ? "business" : "account";
}

export default async function SuspendedPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string | string[] }>;
}) {
  const { type } = await searchParams;
  const copy = COPY[resolveSuspensionType(type)];
  const appealHref = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(copy.subject)}`;

  return (
    <AuthCard title={copy.title} subtitle={copy.body}>
      <a
        href={appealHref}
        className="inline-flex h-10 items-center justify-center rounded-full border border-outline px-6 text-label-l text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        Appeal this suspension
      </a>
      <form action={signOut}>
        <Button type="submit" variant="text" className="w-full">
          Log out
        </Button>
      </form>
    </AuthCard>
  );
}
