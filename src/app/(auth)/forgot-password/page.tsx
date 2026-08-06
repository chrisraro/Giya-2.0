"use client";

import * as React from "react";
import Link from "next/link";
import type HCaptcha from "@hcaptcha/react-hcaptcha";
import { AuthCard } from "@/components/auth/auth-card";
import { Captcha, CAPTCHA_ENABLED } from "@/components/auth/captcha";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { withMinDelay } from "@/lib/auth/timing";

const EMAIL_RE = /^\S+@\S+\.\S+$/;

// Floor under the resetPasswordForEmail round trip so a known address (which
// may involve minting a token and handing off to the mail provider) and an
// unknown one (which can short-circuit) are not distinguishable by how long
// the request took. See src/lib/auth/timing.ts.
const MIN_RESPONSE_DELAY_MS = 800;

export default function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("");
  const [emailError, setEmailError] = React.useState("");
  const [formError, setFormError] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [sentTo, setSentTo] = React.useState("");
  const [captchaToken, setCaptchaToken] = React.useState("");
  const captchaRef = React.useRef<HCaptcha>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!email.trim()) {
      setEmailError("Email is required");
      return;
    }
    if (!EMAIL_RE.test(email)) {
      setEmailError("Enter a valid email address");
      return;
    }
    setEmailError("");

    if (CAPTCHA_ENABLED && !captchaToken) {
      setFormError("Please complete the captcha.");
      return;
    }

    setFormError("");
    setSubmitting(true);
    const supabase = createClient();
    // Deliberately not branching on the outcome here, in either direction:
    // Supabase's own recovery endpoint answers alike for a registered and
    // an unregistered address, and this page must not reintroduce the leak
    // by treating a rejected promise (network hiccup, provider error) any
    // differently from a resolved one. try/catch exists only to stop a
    // thrown network error from crashing the page - the catch block is
    // empty on purpose, since surfacing it would itself be a second, louder
    // channel for the same leak this page exists to close.
    try {
      await withMinDelay(
        () =>
          supabase.auth.resetPasswordForEmail(email, {
            redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
            ...(captchaToken && { captchaToken }),
          }),
        MIN_RESPONSE_DELAY_MS,
      );
    } catch {
      // Swallowed intentionally - see comment above.
    }
    setSubmitting(false);
    // Each hCaptcha token is single-use: reset the widget after every
    // submit so a retry (from the confirmation screen's own "back to sign
    // in" flow, or a future resend) gets a fresh token.
    captchaRef.current?.resetCaptcha();
    setCaptchaToken("");
    setSentTo(email);
  }

  if (sentTo) {
    return (
      <AuthCard title="Check your email" subtitle="If an account exists, we sent password reset instructions to:">
        <p className="text-center text-body-l text-on-surface">{sentTo}</p>
        <p className="text-center text-body-s text-on-surface-variant">
          Open the link on this device to choose a new password. If you do not see it, check your
          spam folder.
        </p>
        <Link
          href="/login"
          className="self-center text-label-l text-primary hover:underline"
        >
          Back to sign in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter your email and we'll send you a reset link."
      footer={
        <p className="text-body-m text-on-surface-variant">
          <Link href="/login" className="text-primary hover:underline">
            Back to sign in
          </Link>
        </p>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <TextField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (emailError) setEmailError("");
          }}
          {...(emailError ? { errorText: emailError } : {})}
        />
        <Captcha
          ref={captchaRef}
          onVerify={setCaptchaToken}
          onExpire={() => setCaptchaToken("")}
          onError={() => {
            setFormError("The captcha did not load. Refresh the page and try again.");
            setCaptchaToken("");
          }}
        />
        {formError ? (
          <p role="alert" className="text-body-s text-error">
            {formError}
          </p>
        ) : null}
        <Button type="submit" variant="filled" size="touch" className="w-full" disabled={submitting}>
          {submitting ? "Sending..." : "Send reset link"}
        </Button>
      </form>
    </AuthCard>
  );
}
