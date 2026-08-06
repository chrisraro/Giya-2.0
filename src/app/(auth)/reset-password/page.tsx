"use client";

import * as React from "react";
import Link from "next/link";
import type { AMREntry } from "@supabase/supabase-js";
import { AuthCard } from "@/components/auth/auth-card";
import { PasswordField } from "@/components/auth/password-field";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { toErrorMessage } from "@/lib/auth/error-message";

type Status = "checking" | "no-session" | "ready" | "done";

// The JWT's `amr` claim is typed as EITHER AMREntry[] (the detailed
// {method, timestamp} shape GoTrue emits by default, ordered most-recent
// first) OR string[] (the plainer RFC-8176-compliant shape a custom access
// token hook could produce instead) - never a mixed array of both. Reading
// amr[0] straight off a union of two array types does not narrow to
// `AMREntry | string`; this normalizes either shape down to the one string
// this page actually needs to compare against "recovery".
function mostRecentAuthMethod(amr: AMREntry[] | string[] | undefined): string | undefined {
  if (!amr || amr.length === 0) return undefined;
  const first = amr[0];
  return typeof first === "string" ? first : first?.method;
}

export default function ResetPasswordPage() {
  const [status, setStatus] = React.useState<Status>("checking");
  const [password, setPassword] = React.useState("");
  const [passwordError, setPasswordError] = React.useState("");
  const [formError, setFormError] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!password) {
      setPasswordError("Password is required");
      return;
    }
    setPasswordError("");
    setFormError("");
    setSubmitting(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setSubmitting(false);
      setFormError(toErrorMessage(error));
      return;
    }
    // The recovery link's session did its one job. Sign it out and send the
    // user back through a normal login with the new password rather than
    // leaving them signed in on whatever device opened the emailed link -
    // that device is not guaranteed to be the account owner's.
    await supabase.auth.signOut();
    setSubmitting(false);
    setStatus("done");
  }

  React.useEffect(() => {
    let cancelled = false;
    let admitted = false;
    const supabase = createClient();

    function admit() {
      admitted = true;
      if (!cancelled) setStatus("ready");
    }

    // supabase-js's own, documented signal that the CURRENT session came
    // from a recovery link:
    // https://supabase.com/docs/reference/javascript/auth-onauthstatechange.
    // Kept as a first-class admission path, not just a fallback - it is the
    // standard mechanism for this exact gate, even though (see the comment
    // below) it may never fire in THIS app's specific architecture.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") admit();
    });

    // The mechanism that actually makes this gate work here: /auth/callback
    // exchanges a recovery link's code for a session SERVER-SIDE (see that
    // route), so THIS browser client never itself processes a recovery
    // URL - which is exactly the code path that normally fires the
    // PASSWORD_RECOVERY event above. What GoTrue always stamps, regardless
    // of where the exchange happened, is the `amr` (Authentication Methods
    // Reference) claim on the issued JWT: entries are ordered most-recent
    // first, and the most recent one names "recovery" exactly when the
    // session's last authentication was this flow - see
    // https://supabase.com/docs/guides/auth/jwt-fields. A plain, ordinary
    // signed-in session (or an anonymous caller with no session at all)
    // never carries that, so this is what actually keeps "any session"
    // from being enough to reach the form below: reaching it requires
    // proof of a recovery flow specifically, not merely being logged in.
    supabase.auth
      .getClaims()
      .then(({ data }) => {
        if (cancelled || admitted) return;
        if (mostRecentAuthMethod(data?.claims?.amr) === "recovery") {
          admit();
        } else {
          setStatus("no-session");
        }
      })
      .catch(() => {
        // A failed check is treated the same as no session: an actionable
        // "request a new link" message, never a permanently blank screen.
        if (!cancelled && !admitted) setStatus("no-session");
      });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  if (status === "checking") {
    return null;
  }

  if (status === "no-session") {
    return (
      <AuthCard title="Reset your password">
        <p className="text-center text-body-m text-on-surface-variant">
          That link expired or was already used.
        </p>
        <Link
          href="/forgot-password"
          className="self-center text-label-l text-primary hover:underline"
        >
          Request a new link
        </Link>
      </AuthCard>
    );
  }

  if (status === "done") {
    return (
      <AuthCard title="Password updated">
        <p className="text-center text-body-m text-on-surface-variant">
          Sign in with your new password.
        </p>
        <Link href="/login" className="self-center text-label-l text-primary hover:underline">
          Sign in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password">
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <PasswordField
          id="new-password"
          label="New password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (passwordError) setPasswordError("");
          }}
          {...(passwordError ? { errorText: passwordError } : {})}
        />
        {formError ? (
          <p role="alert" className="text-body-s text-error">
            {formError}
          </p>
        ) : null}
        <Button type="submit" variant="filled" size="touch" className="w-full" disabled={submitting}>
          {submitting ? "Updating..." : "Update password"}
        </Button>
      </form>
    </AuthCard>
  );
}
