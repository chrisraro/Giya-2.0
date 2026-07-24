"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { SocialButtons } from "@/components/auth/social-buttons";
import { PasswordField } from "@/components/auth/password-field";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const EMAIL_RE = /^\S+@\S+\.\S+$/;

type Role = "consumer" | "business";

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

  function handleSubmit(event: React.FormEvent) {
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

    // TODO(auth): wire Supabase
    router.push(role === "consumer" ? "/onboarding" : "/business/onboarding");
  }

  function handleSocialStub() {
    // TODO(auth): wire Supabase
    router.push(role === "consumer" ? "/onboarding" : "/business/onboarding");
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
        <Button type="submit" variant="filled" size="touch" className="w-full">
          Create account
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
