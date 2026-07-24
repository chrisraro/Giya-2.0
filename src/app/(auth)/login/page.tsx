"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { SocialButtons } from "@/components/auth/social-buttons";
import { PasswordField } from "@/components/auth/password-field";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { getSafeRedirect } from "@/lib/auth/safe-redirect";

const EMAIL_RE = /^\S+@\S+\.\S+$/;

type SocialProvider = "google" | "facebook";

const PROVIDER_LABEL: Record<SocialProvider, string> = {
  google: "Google",
  facebook: "Facebook",
};

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [emailError, setEmailError] = React.useState("");
  const [passwordError, setPasswordError] = React.useState("");
  const [formError, setFormError] = React.useState("");
  const [socialError, setSocialError] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [showExpiredNotice, setShowExpiredNotice] = React.useState(
    searchParams.get("error") === "confirm",
  );

  const next = getSafeRedirect(searchParams.get("next"), "/home");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    let hasError = false;

    if (!email.trim()) {
      setEmailError("Email is required");
      hasError = true;
    } else if (!EMAIL_RE.test(email)) {
      setEmailError("Enter a valid email address");
      hasError = true;
    } else {
      setEmailError("");
    }

    if (!password) {
      setPasswordError("Password is required");
      hasError = true;
    } else {
      setPasswordError("");
    }

    if (hasError) return;

    setFormError("");
    setSubmitting(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);

    if (error) {
      setFormError(
        error.message.toLowerCase().includes("invalid login credentials")
          ? "Email or password is incorrect."
          : error.message,
      );
      return;
    }

    router.push(next);
  }

  async function handleSocial(provider: SocialProvider) {
    setSocialError("");
    const supabase = createClient();
    // encodeURIComponent here (unlike the signup page's two static
    // destinations) because `next` on this page comes from the request's
    // own query string by way of getSafeRedirect: it is validated to be
    // internal, but not guaranteed free of "?"/"&", which would otherwise
    // corrupt this URL's own `next` query param.
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });

    if (error) {
      setSocialError(`${PROVIDER_LABEL[provider]} sign-in is not configured yet.`);
    }
  }

  return (
    <AuthCard
      title="Welcome back"
      subtitle="Sign in to keep earning rewards."
      footer={
        <>
          <p className="text-body-m text-on-surface-variant">
            New to Giya?{" "}
            <Link href="/signup" className="text-primary hover:underline">
              Create an account
            </Link>
          </p>
          <Link href="/business/dashboard" className="text-label-l text-on-surface-variant hover:underline">
            Business sign in
          </Link>
        </>
      }
    >
      {showExpiredNotice ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-md3-md border border-outline-variant bg-surface-container p-3 text-body-s text-on-surface-variant"
        >
          <p>That link expired or was already used. Sign in or request a new one.</p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setShowExpiredNotice(false)}
            className="shrink-0 text-on-surface-variant hover:text-on-surface"
          >
            <span aria-hidden className="material-symbols-rounded text-[18px]">
              close
            </span>
          </button>
        </div>
      ) : null}
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
        <div className="flex flex-col gap-2">
          <PasswordField
            id="password"
            label="Password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              if (passwordError) setPasswordError("");
            }}
            {...(passwordError ? { errorText: passwordError } : {})}
          />
          <Link href="#" className="self-end text-label-l text-primary hover:underline">
            Forgot password
          </Link>
        </div>
        {formError ? (
          <p role="alert" className="text-body-s text-error">
            {formError}
          </p>
        ) : null}
        <Button type="submit" variant="filled" size="touch" className="w-full" disabled={submitting}>
          {submitting ? "Signing in..." : "Sign in"}
        </Button>
      </form>
      <div className="flex items-center gap-3 text-label-m text-on-surface-variant" aria-hidden>
        <span className="h-px flex-1 bg-outline-variant" />
        or
        <span className="h-px flex-1 bg-outline-variant" />
      </div>
      <SocialButtons
        onGoogle={() => handleSocial("google")}
        onFacebook={() => handleSocial("facebook")}
      />
      {socialError ? (
        <p role="alert" className="text-body-s text-error">
          {socialError}
        </p>
      ) : null}
    </AuthCard>
  );
}

// useSearchParams() requires a Suspense boundary above it so this page can
// still be statically optimized where possible; the fallback never
// actually renders in practice since there is no async data dependency,
// only the hook's opt-in to dynamic rendering.
export default function LoginPage() {
  return (
    <React.Suspense fallback={null}>
      <LoginPageInner />
    </React.Suspense>
  );
}
