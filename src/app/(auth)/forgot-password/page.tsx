"use client";

import * as React from "react";
import Link from "next/link";
import type HCaptcha from "@hcaptcha/react-hcaptcha";
import { AuthCard } from "@/components/auth/auth-card";
import { Captcha, CAPTCHA_ENABLED } from "@/components/auth/captcha";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";

const EMAIL_RE = /^\S+@\S+\.\S+$/;

const RATE_LIMIT_MESSAGE = "Too many requests. Please wait a moment and try again.";

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

    // The actual Supabase call - and the rate limit and timing floor that
    // guard it - live server-side in
    // src/app/api/v1/auth/forgot-password/route.ts, which is the only thing
    // that can be gated by this repo's limiter (src/lib/rate-limit.ts); a
    // browser calling Supabase directly never touches it. `response` stays
    // null on a thrown network error rather than letting the page crash.
    let response: Response | null = null;
    try {
      response = await fetch("/api/v1/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, ...(captchaToken && { captchaToken }) }),
      });
    } catch {
      // Falls through to the generic confirmation below - see comment there.
    }

    setSubmitting(false);
    // Each hCaptcha token is single-use: reset the widget after every
    // submit so a retry gets a fresh token.
    captchaRef.current?.resetCaptcha();
    setCaptchaToken("");

    // A 429 from OUR OWN limiter is the one outcome this page is allowed to
    // show differently. Being throttled says nothing about whether `email`
    // has an account: the route's two budgets are keyed by caller IP and by
    // the raw address itself, checked BEFORE Supabase is ever asked, so a
    // known and an unknown address hit the exact same limiter the exact
    // same way. Surfacing "you're going too fast" is therefore not the leak
    // this page exists to prevent.
    //
    // Everything else - 200, any other status the route might ever answer
    // with, or the fetch above throwing outright - collapses to the same
    // confirmation, for the same reason the route itself never branches on
    // Supabase's own answer: there is no other outcome here that is safe to
    // describe differently.
    if (response?.status === 429) {
      setFormError(RATE_LIMIT_MESSAGE);
      return;
    }

    setSentTo(email);
  }

  if (sentTo) {
    return (
      <AuthCard
        title="Check your email"
        subtitle="If that address has an account, we've sent a link to:"
      >
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
