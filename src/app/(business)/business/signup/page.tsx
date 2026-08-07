"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { SocialButtons } from "@/components/auth/social-buttons";
import { PasswordField } from "@/components/auth/password-field";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { registerCurrentDevice } from "@/features/identity/actions";

const EMAIL_RE = /^\S+@\S+\.\S+$/;

export default function BusinessSignupPage() {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [emailError, setEmailError] = React.useState("");
  const [passwordError, setPasswordError] = React.useState("");
  const [formError, setFormError] = React.useState("");
  const [socialError, setSocialError] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  function getBaseUrl(): string {
    if (typeof window !== "undefined") {
      return (process.env.NEXT_PUBLIC_APP_URL || window.location.origin).replace(/\/$/, "");
    }
    return (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  }

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
    } else if (password.length < 8) {
      setPasswordError("Password must be at least 8 characters");
      hasError = true;
    } else {
      setPasswordError("");
    }

    if (hasError) return;

    setFormError("");
    setSubmitting(true);

    try {
      const supabase = createClient();
      const baseUrl = getBaseUrl();

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${baseUrl}/auth/callback?next=/business/onboarding`,
          data: {
            role: "business",
          },
        },
      });

      if (error) {
        setFormError(error.message);
        return;
      }

      if (data.session) {
        try {
          await registerCurrentDevice();
        } catch (devErr) {
          console.error("[identity] device registration threw during business signup", devErr);
        }
        router.push("/business/onboarding");
      } else {
        router.push("/business/pending-approval");
      }
    } catch (err: any) {
      setFormError(err?.message || "Failed to create business account.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSocial(provider: "google" | "facebook") {
    setSocialError("");
    const supabase = createClient();
    const baseUrl = getBaseUrl();

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${baseUrl}/auth/callback?next=/business/onboarding`,
      },
    });

    if (error) {
      setSocialError(`${provider.toUpperCase()} sign-in failed.`);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <AuthCard
        title="Register your Business"
        subtitle="Create your merchant portal account to launch loyalty cards and rewards."
      >
        <SocialButtons
          onGoogle={() => handleSocial("google")}
          onFacebook={() => handleSocial("facebook")}
        />

        {socialError ? (
          <p role="alert" className="mt-3 text-body-s text-error">
            {socialError}
          </p>
        ) : null}

        <div className="my-4 flex items-center gap-3">
          <div className="h-px flex-1 bg-outline-variant" />
          <span className="text-label-m text-on-surface-variant">or email</span>
          <div className="h-px flex-1 bg-outline-variant" />
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {formError ? (
            <div role="alert" className="rounded-md3-xs bg-error-container p-3 text-body-s text-on-error-container">
              {formError}
            </div>
          ) : null}

          <TextField
            id="business-email"
            type="email"
            label="Business Email"
            placeholder="owner@yourstore.ph"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            errorText={emailError}
            required
          />

          <PasswordField
            id="business-password"
            label="Create Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            errorText={passwordError}
            required
          />

          <Button type="submit" variant="filled" size="touch" className="mt-2" disabled={submitting}>
            {submitting ? "Registering..." : "Create Merchant Account"}
          </Button>
        </form>

        <div className="mt-4 flex flex-col items-center gap-2 text-center">
          <Link href="/business/login" className="text-label-m text-primary hover:underline font-medium">
            Already have a merchant account? Sign in →
          </Link>
          <Link href="/signup" className="text-label-s text-on-surface-variant hover:underline">
            Looking for consumer rewards? Consumer Signup →
          </Link>
        </div>
      </AuthCard>
    </div>
  );
}
