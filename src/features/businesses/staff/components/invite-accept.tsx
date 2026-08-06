"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

import { acceptInviteAction } from "../actions";

export interface InviteAcceptProps {
  token: string;
}

/**
 * The one write on `/invite/[token]`. Split out of the page (a server
 * component) because accepting is a user-initiated CLICK, never a page
 * render - see service.ts's `previewInvite` header for why that split is
 * load-bearing, not just componentisation.
 */
export function InviteAccept({ token }: InviteAcceptProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function accept() {
    setPending(true);
    setError(null);

    const result = await acceptInviteAction(token);

    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }

    // Review fix I5: the session cookie on THIS browser predates the
    // business_staff row `acceptInviteAction` just flipped to 'active' - it
    // was issued at the invitee's own sign-in/sign-up, before this invite
    // ever existed, so it carries no `biz` claim for the tenant they just
    // joined. Pushing straight to /business/dashboard on that stale token
    // means the dashboard's own `is_staff_of`-backed reads come back empty.
    // Same fix, same reasoning, as `business/onboarding/page.tsx`'s
    // `finish()` after `registerBusiness()` - cloned here rather than
    // shared, matching that file's own comment being local to its call site.
    // Best-effort: a refresh failure must not strand the invitee on this
    // page when the accept itself already committed server-side.
    try {
      await createClient().auth.refreshSession();
    } catch (refreshError) {
      console.error("[businesses/staff] session refresh after accept failed", refreshError);
    }

    router.push("/business/dashboard");
  }

  return (
    <div className="flex flex-col gap-3">
      <Button type="button" variant="filled" size="touch" disabled={pending} onClick={() => void accept()}>
        {pending ? "Joining..." : "Accept invite"}
      </Button>
      {error ? (
        <p role="alert" className="text-body-s text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
