"use client";

import * as React from "react";
import Link from "next/link";
import { AuthCard } from "@/components/auth/auth-card";
import { PasswordField } from "@/components/auth/password-field";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { toErrorMessage } from "@/lib/auth/error-message";

type Status = "checking" | "no-session" | "ready" | "done";

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
    const supabase = createClient();
    // /auth/callback already exchanges the recovery link's code for a
    // session and redirects here - so a session should already exist by
    // the time this page mounts. It will NOT exist if someone bookmarks
    // or revisits this URL directly (or after that exchange failed and
    // /auth/callback bounced them to /login instead), so this page still
    // has to check rather than assume.
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setStatus(data.session ? "ready" : "no-session");
    });
    return () => {
      cancelled = true;
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
