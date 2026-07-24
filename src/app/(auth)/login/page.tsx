"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { SocialButtons } from "@/components/auth/social-buttons";
import { PasswordField } from "@/components/auth/password-field";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";

const EMAIL_RE = /^\S+@\S+\.\S+$/;

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [emailError, setEmailError] = React.useState("");
  const [passwordError, setPasswordError] = React.useState("");

  function handleSubmit(event: React.FormEvent) {
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

    // TODO(auth): wire Supabase
    router.push("/home");
  }

  function handleSocialStub() {
    // TODO(auth): wire Supabase
    router.push("/home");
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
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <TextField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          {...(emailError ? { errorText: emailError } : {})}
        />
        <div className="flex flex-col gap-2">
          <PasswordField
            id="password"
            label="Password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            {...(passwordError ? { errorText: passwordError } : {})}
          />
          <Link href="#" className="self-end text-label-l text-primary hover:underline">
            Forgot password
          </Link>
        </div>
        <Button type="submit" variant="filled" size="touch" className="w-full">
          Sign in
        </Button>
      </form>
      <div className="flex items-center gap-3 text-label-m text-on-surface-variant" aria-hidden>
        <span className="h-px flex-1 bg-outline-variant" />
        or
        <span className="h-px flex-1 bg-outline-variant" />
      </div>
      <SocialButtons onGoogle={handleSocialStub} onFacebook={handleSocialStub} />
    </AuthCard>
  );
}
