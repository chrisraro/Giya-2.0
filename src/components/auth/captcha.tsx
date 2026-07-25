"use client";

import * as React from "react";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import { useTheme } from "next-themes";
import { env } from "@/lib/env";

// When the site key is unset (local dev without hCaptcha configured, or a
// build that has not been given one), the widget does not render and callers
// must treat captcha as not-required: skip the gate, omit captchaToken.
export const CAPTCHA_ENABLED = Boolean(env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY);

export interface CaptchaProps {
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: () => void;
}

const emptySubscribe = () => () => {};

// Ref-based so pages can call `ref.current?.resetCaptcha()` after every
// submit (success or failure) - each hCaptcha token is single-use, so a
// retry needs a fresh one.
export const Captcha = React.forwardRef<HCaptcha, CaptchaProps>(function Captcha(
  { onVerify, onExpire, onError },
  ref,
) {
  const { resolvedTheme } = useTheme();
  // Hydration-safe mounted check (matches ThemeToggle's pattern): false on
  // the server snapshot, true on the client, so this defaults to light
  // instead of risking a server/client theme mismatch on first paint.
  const mounted = React.useSyncExternalStore(emptySubscribe, () => true, () => false);

  const siteKey = env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY;
  if (!siteKey) return null;

  return (
    <div className="flex justify-center overflow-x-auto">
      <HCaptcha
        ref={ref}
        sitekey={siteKey}
        theme={mounted && resolvedTheme === "dark" ? "dark" : "light"}
        onVerify={onVerify}
        {...(onExpire ? { onExpire } : {})}
        {...(onError ? { onError } : {})}
      />
    </div>
  );
});
