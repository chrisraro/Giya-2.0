"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { Stepper } from "@/components/auth/stepper";
import { OptInSwitch } from "@/components/auth/opt-in-switch";
import { Chip } from "@/components/ui/chip";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { completeConsumerOnboarding } from "@/features/identity/actions";
import { CityPicker } from "@/features/identity/components/city-picker";

const STEP_COUNT = 4;

const INTERESTS = [
  "Milk tea",
  "Coffee",
  "Bakery",
  "Samgyupsal",
  "Fast food",
  "Desserts",
  "Silog",
  "Ramen",
];

const VALUE_PROPS: { title: string; body: string; className: string }[] = [
  { title: "Earn", body: "Points on every visit", className: "text-primary" },
  { title: "Collect", body: "Stamps toward free stuff", className: "text-tertiary" },
  { title: "Redeem", body: "Real rewards nearby", className: "text-secondary" },
];

function WelcomeStep() {
  return (
    <div className="flex flex-col items-center gap-8 py-2 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="text-headline-s text-on-surface">Welcome to Giya</h1>
        <p className="text-body-m text-on-surface-variant">
          A few quick steps and you are ready to start earning.
        </p>
      </div>
      <div className="grid w-full grid-cols-3 gap-3">
        {VALUE_PROPS.map((item) => (
          <div key={item.title} className="flex flex-col items-center gap-2">
            <Logo variant="stamp" className={item.className} />
            <span className="text-label-l text-on-surface">{item.title}</span>
            <span className="text-body-s text-on-surface-variant">{item.body}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Heading plus the shared picker. Everything that used to live here - the
// ref_cities read, the search field, the roving-focus list and the arrow-key
// handler - is now src/features/identity/components/city-picker.tsx, so
// /profile/edit uses the same control rather than a second copy of it.
function CityStep({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (city: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 text-center">
        <h2 className="text-headline-s text-on-surface">What city are you in?</h2>
        <p className="text-body-m text-on-surface-variant">
          We will show you deals nearby first.
        </p>
      </div>
      <CityPicker value={selected} onChange={onSelect} />
    </div>
  );
}

function InterestsStep({
  selected,
  onToggle,
}: {
  selected: Set<string>;
  onToggle: (label: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 text-center">
        <h2 className="text-headline-s text-on-surface">What do you love?</h2>
        <p className="text-body-m text-on-surface-variant">
          Pick a few. We will use these to find your best deals.
        </p>
      </div>
      <div role="group" aria-label="What you love" className="flex flex-wrap justify-center gap-2">
        {INTERESTS.map((label) => (
          <Chip
            key={label}
            label={label}
            selected={selected.has(label)}
            onClick={() => onToggle(label)}
          />
        ))}
      </div>
    </div>
  );
}

function NotificationsStep({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 text-center">
        <h2 className="text-headline-s text-on-surface">Stay in the loop</h2>
        <p className="text-body-m text-on-surface-variant">
          Get a nudge when a reward is ready or a deal opens up nearby. You can turn this off
          anytime in settings.
        </p>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-md3-md border border-outline-variant bg-surface p-4">
        <div className="flex flex-col gap-1">
          <span className="text-label-l text-on-surface">Push notifications</span>
          <span className="text-body-s text-on-surface-variant">
            Reward alerts and nearby deals
          </span>
        </div>
        <OptInSwitch checked={checked} onChange={onChange} label="Push notifications" />
      </div>
    </div>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const reduce = useReducedMotion();

  const [step, setStep] = React.useState(0);
  const [direction, setDirection] = React.useState<1 | -1>(1);
  const [city, setCity] = React.useState<string | null>(null);
  const [interests, setInterests] = React.useState<Set<string>>(new Set());
  const [notifications, setNotifications] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const canContinue = step !== 1 || city !== null;

  async function finish() {
    // Guards against Finish/Skip firing the completion RPC twice (same
    // fast double click/tap race as the business registration flow).
    if (pending) return;
    setPending(true);
    const result = await completeConsumerOnboarding({ cityName: city, pushEnabled: notifications });
    setPending(false);
    if (!result.ok) {
      // This used to navigate to /home anyway ("onboarding is non-blocking").
      // It cannot anymore: the consumer layout now redirects anyone whose
      // profiles.onboarded_at is still null straight back here, so pushing
      // forward on a failed save would bounce the user to a freshly reset
      // wizard with the error already gone. Staying put keeps the message on
      // screen and lets them retry.
      setError(result.message);
      return;
    }
    router.push("/home");
  }

  function goNext() {
    if (step === STEP_COUNT - 1) {
      void finish();
      return;
    }
    setDirection(1);
    setStep((s) => s + 1);
  }

  function goBack() {
    setDirection(-1);
    setStep((s) => Math.max(0, s - 1));
  }

  async function handleSkip() {
    // Same double-submit guard as finish(): idempotent-ish either way, but
    // this keeps behavior consistent and rate-safe.
    if (pending) return;
    setPending(true);
    // CRITICAL: this call is now unconditional. It used to be skipped when no
    // city had been picked, which left profiles.onboarded_at null - and the
    // consumer layout's gate reads exactly that column to decide whether to
    // send someone here. Skipping without stamping would therefore mean
    // "Skip for now" pushes to /home, the layout sees a null stamp and
    // redirects back to /onboarding, forever. The action already tolerates a
    // null city (it resolves to a null city_id and still succeeds), so
    // "skipped" is recorded as a completed-with-no-answers onboarding.
    const result = await completeConsumerOnboarding({
      cityName: city,
      pushEnabled: notifications,
    });
    setPending(false);
    if (!result.ok) {
      // Same reasoning as finish(): a failed stamp means the gate will bounce
      // them straight back, so stay here and show why.
      setError(result.message);
      return;
    }
    router.push("/home");
  }

  function toggleInterest(label: string) {
    setInterests((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }

  // Entrance-only animation: exit animations under AnimatePresence mode="wait"
  // deadlocked in production (old step never unmounted, next step never
  // mounted), so each step slides in on mount and the old one unmounts
  // instantly. Reduced motion collapses to no movement.
  const stepMotion = reduce
    ? { initial: false as const }
    : {
        initial: { x: direction > 0 ? 24 : -24, opacity: 0 },
        animate: { x: 0, opacity: 1 },
      };

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <Stepper steps={STEP_COUNT} activeIndex={step} />
        <button
          type="button"
          onClick={handleSkip}
          disabled={pending}
          className="flex h-12 shrink-0 items-center rounded-md3-sm px-3 text-label-l text-on-surface-variant outline-none transition-colors duration-200 ease-standard hover:text-on-surface focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-40"
        >
          Skip for now
        </button>
      </div>

      <div className="relative overflow-hidden">
          <motion.div
            key={step}
            {...stepMotion}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 300, damping: 30 }}
            className="flex flex-col gap-6"
          >
            {step === 0 && <WelcomeStep />}
            {step === 1 && <CityStep selected={city} onSelect={setCity} />}
            {step === 2 && <InterestsStep selected={interests} onToggle={toggleInterest} />}
            {step === 3 && (
              <NotificationsStep checked={notifications} onChange={setNotifications} />
            )}
          </motion.div>
      </div>

      {error ? (
        <p role="alert" className="text-body-s text-error">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        {step > 0 && (
          <Button type="button" variant="text" size="touch" onClick={goBack}>
            Back
          </Button>
        )}
        <Button
          type="button"
          variant="filled"
          size="touch"
          className="flex-1"
          disabled={!canContinue || pending}
          onClick={goNext}
        >
          {step === STEP_COUNT - 1 ? "Finish" : "Continue"}
        </Button>
      </div>
    </div>
  );
}
