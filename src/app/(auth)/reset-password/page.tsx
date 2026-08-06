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

    // The gate lives entirely server-side now: /auth/confirm sets an
    // httpOnly cookie ONLY after successfully verifying THIS link's
    // token_hash as an explicit type: "recovery" OTP - never inferred
    // after the fact from a session's claims (a session's `amr` claim
    // cannot make that distinction: recovery, invite, signup and
    // magic-link all record identically as `amr: "otp"`). This page is a
    // Client Component and cannot read that httpOnly cookie itself, so it
    // asks GET /auth/recovery-status, the one thing that can.
    fetch("/auth/recovery-status")
      .then((response) => response.json())
      .then((json: { data?: { verified?: boolean } }) => {
        if (cancelled) return;
        setStatus(json?.data?.verified ? "ready" : "no-session");
      })
      .catch(() => {
        // A failed check is treated the same as no session: an actionable
        // "request a new link" message, never a permanently blank screen.
        if (!cancelled) setStatus("no-session");
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
