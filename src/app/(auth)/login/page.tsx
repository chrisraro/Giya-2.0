"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type HCaptcha from "@hcaptcha/react-hcaptcha";
import { AuthCard } from "@/components/auth/auth-card";
import { SocialButtons } from "@/components/auth/social-buttons";
import { PasswordField } from "@/components/auth/password-field";
import { Captcha, CAPTCHA_ENABLED } from "@/components/auth/captcha";
import { registerCurrentDevice } from "@/features/identity/actions";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { getSafeRedirect } from "@/lib/auth/safe-redirect";
import { toErrorMessage } from "@/lib/auth/error-message";

const EMAIL_RE = /^\S+@\S+\.\S+$/;

type SocialProvider = "google" | "facebook";

const PROVIDER_LABEL: Record<SocialProvider, string> = {
  google: "Google",
  facebook: "Facebook",
};

/**
 * Copy for each `?error=` code /auth/callback can send this page.
 *
 * `confirm` covers a dead PKCE handshake: no `code` on the URL, or an
 * exchange that Supabase rejected. `oauth` covers a provider that answered
 * with an error instead, which is overwhelmingly someone tapping Cancel on a
 * consent screen and should not be described as an expired link.
 */
const CALLBACK_NOTICE: Record<string, string> = {
  confirm: "That link expired or was already used. Sign in or request a new one.",
  oauth: "That sign-in was cancelled or the provider turned it down. Try again below.",
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
  const [captchaToken, setCaptchaToken] = React.useState("");
  const captchaRef = React.useRef<HCaptcha>(null);
  // /auth/callback redirects here with a fixed error code (never the
  // provider's own message, which is attacker-controllable text). This page
  // owns the wording for each code; anything unrecognised shows no notice at
  // all rather than echoing a query param back at the user.
  const noticeCode = searchParams.get("error");
  const notice = noticeCode === null ? null : CALLBACK_NOTICE[noticeCode] ?? null;
  const [dismissedNotice, setDismissedNotice] = React.useState(false);

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

    if (CAPTCHA_ENABLED && !captchaToken) {
      setFormError("Please complete the captcha.");
      return;
    }

    setFormError("");
    setSubmitting(true);

    // THE WHOLE TAIL IS INSIDE try/finally, and `setSubmitting(false)` is the
    // finally. It used to run the instant signInWithPassword returned, which
    // was harmless while the very next statement was the navigation - and is
    // not now that a server-action round trip sits between them. For the whole
    // duration of that round trip the button was re-enabled, still read "Sign
    // in", and the page had not moved: a very tappable window on a Philippine
    // mobile connection, and a second tap would run a second
    // signInWithPassword AND a second registerCurrentDevice - the most likely
    // real-world route to the duplicate `user_devices` row that
    // server/devices.ts documents as a theoretical race.
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
        options: {
          ...(captchaToken && { captchaToken }),
        },
      });
      // Each hCaptcha token is single-use: reset the widget after every submit
      // (success or failure) so a retry gets a fresh token.
      captchaRef.current?.resetCaptcha();
      setCaptchaToken("");

      if (error) {
        // Live E2E showed a non-Error rejection rendering as "{}"; route
        // through toErrorMessage so this always ends up a real string.
        const message = toErrorMessage(error);
        setFormError(
          message.toLowerCase().includes("invalid login credentials")
            ? "Email or password is incorrect."
            : message,
        );
        return;
      }

      // A session now exists, so this browser is a device. Registering here and
      // not somewhere more central is a consequence of where sessions are
      // actually created: this path runs entirely in the browser, and only the
      // server can see the request's user agent or write to `user_devices`, so
      // a server action is the seam. /auth/callback does the same for the PKCE
      // and OAuth path, on the server, where it already is.
      //
      // AWAITED, not fired and forgotten. A pending request is cancelled by the
      // navigation below on exactly the slow connections where it would still
      // be pending.
      //
      // The catch is not decoration. The action swallows its own database
      // failures, but the ACTION BOUNDARY can still reject - a dropped
      // connection, a deploy mid-request - and an unhandled rejection here
      // would skip the navigation and leave somebody who has successfully
      // signed in sitting on the login page with nothing written on it.
      try {
        await registerCurrentDevice();
      } catch (thrown) {
        console.error("[identity] device registration threw during sign-in", thrown);
      }

      router.push(next);
    } finally {
      setSubmitting(false);
    }
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
      {notice && !dismissedNotice ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-md3-md border border-outline-variant bg-surface-container p-3 text-body-s text-on-surface-variant"
        >
          <p>{notice}</p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setDismissedNotice(true)}
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
          <Link href="/forgot-password" className="self-end text-label-l text-primary hover:underline">
            Forgot password
          </Link>
        </div>
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
