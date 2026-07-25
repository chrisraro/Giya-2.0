"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type HCaptcha from "@hcaptcha/react-hcaptcha";
import { AuthCard } from "@/components/auth/auth-card";
import { SocialButtons } from "@/components/auth/social-buttons";
import { CheckEmail } from "@/components/auth/check-email";
import { PasswordField } from "@/components/auth/password-field";
import { Captcha, CAPTCHA_ENABLED } from "@/components/auth/captcha";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { toErrorMessage } from "@/lib/auth/error-message";

const EMAIL_RE = /^\S+@\S+\.\S+$/;

type Role = "consumer" | "business";
type SocialProvider = "google" | "facebook";

const PROVIDER_LABEL: Record<SocialProvider, string> = {
  google: "Google",
  facebook: "Facebook",
};

function destinationFor(role: Role): string {
  return role === "consumer" ? "/onboarding" : "/business/onboarding";
}

const ROLES: { id: Role; icon: string; title: string; body: string }[] = [
  {
    id: "consumer",
    icon: "redeem",
    title: "Earn rewards",
    body: "Collect points and stamps at your favorite spots.",
  },
  {
    id: "business",
    icon: "storefront",
    title: "Grow my business",
    body: "Bring customers back with a loyalty program.",
  },
];

function RoleCard({
  role,
  selected,
  onSelect,
  onArrowKey,
  cardRef,
}: {
  role: (typeof ROLES)[number];
  selected: boolean;
  onSelect: () => void;
  onArrowKey: () => void;
  cardRef: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={cardRef}
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
          return;
        }
        if (
          event.key === "ArrowLeft" ||
          event.key === "ArrowRight" ||
          event.key === "ArrowUp" ||
          event.key === "ArrowDown"
        ) {
          event.preventDefault();
          onArrowKey();
        }
      }}
      className={cn(
        "flex flex-1 cursor-pointer flex-col gap-2 rounded-md3-md border p-4 text-left",
        "outline-none transition-colors duration-200 ease-standard",
        "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
        selected
          ? "border-primary bg-primary-container/40"
          : "border-outline-variant bg-surface hover:bg-surface-container",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-9 items-center justify-center rounded-full",
          selected ? "bg-primary text-on-primary" : "bg-surface-container-high text-on-surface-variant",
        )}
      >
        <span className="material-symbols-rounded text-[20px]">{role.icon}</span>
      </span>
      <span className="text-title-s text-on-surface">{role.title}</span>
      <span className="text-body-s text-on-surface-variant">{role.body}</span>
    </div>
  );
}

export default function SignupPage() {
  const router = useRouter();
  const [role, setRole] = React.useState<Role>("consumer");
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [nameError, setNameError] = React.useState("");
  const [emailError, setEmailError] = React.useState("");
  const [passwordError, setPasswordError] = React.useState("");
  const [formError, setFormError] = React.useState("");
  const [socialError, setSocialError] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [confirmationEmail, setConfirmationEmail] = React.useState("");
  const [captchaToken, setCaptchaToken] = React.useState("");
  const captchaRef = React.useRef<HCaptcha>(null);
  const roleCardRefs = React.useRef<Record<Role, HTMLDivElement | null>>({
    consumer: null,
    business: null,
  });

  function handleRoleArrowKey() {
    const currentIndex = ROLES.findIndex((r) => r.id === role);
    const next = ROLES[(currentIndex + 1) % ROLES.length];
    if (!next) return;
    setRole(next.id);
    roleCardRefs.current[next.id]?.focus();
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    let hasError = false;

    if (!name.trim()) {
      setNameError("Name is required");
      hasError = true;
    } else {
      setNameError("");
    }

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
    const supabase = createClient();
    const next = destinationFor(role);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: name, intended_role: role },
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${next}`,
        ...(captchaToken && { captchaToken }),
      },
    });
    setSubmitting(false);
    // Each hCaptcha token is single-use: reset the widget after every submit
    // (success or failure) so a retry gets a fresh token.
    captchaRef.current?.resetCaptcha();
    setCaptchaToken("");

    if (error) {
      // Live E2E showed a non-Error rejection rendering as "{}"; route
      // through toErrorMessage so this always ends up a real string.
      const message = toErrorMessage(error);
      // Supabase's raw message ("User already registered") confirms to an
      // attacker that a given email has an account (an enumeration leak),
      // so this one case gets a neutral, dual-purpose copy instead of the
      // pass-through below.
      setFormError(
        /already registered/i.test(message)
          ? "If that email is new to Giya, we just sent it a confirmation link. If you already have an account, sign in instead."
          : message,
      );
      return;
    }

    if (data.user && !data.session) {
      setConfirmationEmail(email);
      return;
    }

    router.push(next);
  }

  async function handleResend(resendCaptchaToken: string) {
    const supabase = createClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: confirmationEmail,
      options: {
        ...(resendCaptchaToken && { captchaToken: resendCaptchaToken }),
      },
    });
    return { error: error ? toErrorMessage(error) : null };
  }

  async function handleSocial(provider: SocialProvider) {
    setSocialError("");
    const supabase = createClient();
    const next = destinationFor(role);
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${next}` },
    });

    if (error) {
      setSocialError(`${PROVIDER_LABEL[provider]} sign-in is not configured yet.`);
    }
  }

  if (confirmationEmail) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <CheckEmail email={confirmationEmail} onResend={handleResend} />
      </div>
    );
  }

  return (
    <AuthCard
      title="Create your account"
      subtitle="Join Giya in a minute."
      footer={
        <>
          <p className="text-body-s text-on-surface-variant">
            By continuing you agree to the{" "}
            <Link href="/terms" className="text-primary hover:underline">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="text-primary hover:underline">
              Privacy Policy
            </Link>
            .
          </p>
          <p className="text-body-m text-on-surface-variant">
            Already have an account?{" "}
            <Link href="/login" className="text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </>
      }
    >
      <div role="radiogroup" aria-label="I want to" className="flex gap-3">
        {ROLES.map((r) => (
          <RoleCard
            key={r.id}
            role={r}
            selected={role === r.id}
            onSelect={() => setRole(r.id)}
            onArrowKey={handleRoleArrowKey}
            cardRef={(el) => {
              roleCardRefs.current[r.id] = el;
            }}
          />
        ))}
      </div>
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <TextField
          id="name"
          label="Full name"
          autoComplete="name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (nameError) setNameError("");
          }}
          {...(nameError ? { errorText: nameError } : {})}
        />
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
        <PasswordField
          id="password"
          label="Password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (passwordError) setPasswordError("");
          }}
          {...(passwordError ? { errorText: passwordError } : {})}
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
          {submitting ? "Creating account..." : "Create account"}
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
