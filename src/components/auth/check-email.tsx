"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

export interface CheckEmailProps {
  email: string;
  // Returns a normalized { error } shape rather than throwing, so this
  // component never needs to know about Supabase's AuthError type; the
  // caller (the signup page) owns the actual supabase.auth.resend() call.
  onResend: () => Promise<{ error: string | null }>;
}

type ResendStatus = "idle" | "sending" | "sent" | "error";

export function CheckEmail({ email, onResend }: CheckEmailProps) {
  const [status, setStatus] = React.useState<ResendStatus>("idle");
  const [errorText, setErrorText] = React.useState("");

  async function handleResend() {
    setStatus("sending");
    setErrorText("");
    try {
      const { error } = await onResend();
      if (error) {
        setStatus("error");
        setErrorText(error);
        return;
      }
      setStatus("sent");
    } catch {
      setStatus("error");
      setErrorText("Something went wrong. Try again.");
    }
  }

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-md3-xl border border-outline-variant bg-surface p-6 text-center text-on-surface sm:p-8">
      <span
        aria-hidden
        className="flex size-12 items-center justify-center rounded-full bg-primary-container text-on-primary-container"
      >
        <span className="material-symbols-rounded text-[24px]">mail</span>
      </span>
      <h1 className="text-headline-s">Check your email</h1>
      <p className="text-body-m text-on-surface-variant">
        We sent a confirmation link to <span className="text-on-surface">{email}</span>. Open it
        on this device to finish creating your account. If you do not see it, check your spam
        folder.
      </p>
      <Button
        type="button"
        variant="outlined"
        size="touch"
        className="w-full"
        onClick={handleResend}
        disabled={status === "sending"}
      >
        {status === "sending" ? "Sending..." : "Resend email"}
      </Button>
      {status === "sent" ? (
        <p role="status" className="text-body-s text-on-surface-variant">
          Email sent again. Give it a minute to arrive.
        </p>
      ) : null}
      {status === "error" ? (
        <p role="alert" className="text-body-s text-error">
          {errorText}
        </p>
      ) : null}
    </div>
  );
}
