"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { Stepper } from "@/components/auth/stepper";
import { OptInSwitch } from "@/components/auth/opt-in-switch";
import { Chip } from "@/components/ui/chip";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";
import { completeConsumerOnboarding } from "@/features/identity/actions";

const STEP_COUNT = 4;

const CITIES = ["Cebu", "Manila", "Davao", "Iloilo", "Baguio", "Cagayan de Oro"];

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

function CityStep({
  cities,
  search,
  onSearchChange,
  selected,
  onSelect,
  onArrowKey,
  itemRef,
}: {
  cities: string[];
  search: string;
  onSearchChange: (value: string) => void;
  selected: string | null;
  onSelect: (city: string) => void;
  onArrowKey: (direction: 1 | -1) => void;
  itemRef: (city: string, el: HTMLDivElement | null) => void;
}) {
  const selectedVisible = selected !== null && cities.includes(selected);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 text-center">
        <h2 className="text-headline-s text-on-surface">What city are you in?</h2>
        <p className="text-body-m text-on-surface-variant">
          We will show you deals nearby first.
        </p>
      </div>
      <TextField
        id="city-search"
        label="Search city"
        placeholder="Type a city name"
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
      />
      <div
        role="radiogroup"
        aria-label="Your city"
        className="flex max-h-64 flex-col gap-2 overflow-y-auto"
      >
        {cities.length === 0 ? (
          <p className="py-4 text-center text-body-m text-on-surface-variant">
            No cities match &quot;{search}&quot;.
          </p>
        ) : (
          cities.map((city, index) => {
            const isSelected = city === selected;
            const isRovingFallback = !selectedVisible && index === 0;
            return (
              <div
                key={city}
                ref={(el) => itemRef(city, el)}
                role="radio"
                aria-checked={isSelected}
                tabIndex={isSelected || isRovingFallback ? 0 : -1}
                onClick={() => onSelect(city)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(city);
                    return;
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    onArrowKey(1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    onArrowKey(-1);
                  }
                }}
                className={cn(
                  "flex cursor-pointer items-center justify-between rounded-md3-md border px-4 py-3 text-left",
                  "outline-none transition-colors duration-200 ease-standard",
                  "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
                  isSelected
                    ? "border-primary bg-primary-container/40"
                    : "border-outline-variant bg-surface hover:bg-surface-container",
                )}
              >
                <span className="text-body-l text-on-surface">{city}</span>
                {isSelected ? (
                  <span aria-hidden className="material-symbols-rounded is-filled text-primary">
                    check_circle
                  </span>
                ) : null}
              </div>
            );
          })
        )}
      </div>
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
  const [citySearch, setCitySearch] = React.useState("");
  const [interests, setInterests] = React.useState<Set<string>>(new Set());
  const [notifications, setNotifications] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const cityRefs = React.useRef<Record<string, HTMLDivElement | null>>({});

  const filteredCities = React.useMemo(
    () => CITIES.filter((c) => c.toLowerCase().includes(citySearch.trim().toLowerCase())),
    [citySearch],
  );

  const canContinue = step !== 1 || city !== null;

  async function finish() {
    setPending(true);
    const result = await completeConsumerOnboarding({ cityName: city, pushEnabled: notifications });
    setPending(false);
    if (!result.ok) {
      // v0 tolerance: onboarding is non-blocking, so a save failure still
      // navigates the user forward. The inline error only has this instant
      // to be seen before the route change unmounts the page; a real toast
      // system would let it persist across navigation.
      setError(result.message);
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
    if (city !== null) {
      const result = await completeConsumerOnboarding({
        cityName: city,
        pushEnabled: notifications,
      });
      if (!result.ok) {
        // Same v0 tolerance as finish(): non-blocking, still navigates.
        setError(result.message);
      }
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

  function handleCityArrowKey(dir: 1 | -1) {
    if (filteredCities.length === 0) return;
    const idx = filteredCities.findIndex((c) => c === city);
    const currentIndex = idx === -1 ? 0 : idx;
    const nextIndex = (currentIndex + dir + filteredCities.length) % filteredCities.length;
    const next = filteredCities[nextIndex];
    if (!next) return;
    setCity(next);
    cityRefs.current[next]?.focus();
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
          className="flex h-12 shrink-0 items-center rounded-md3-sm px-3 text-label-l text-on-surface-variant outline-none transition-colors duration-200 ease-standard hover:text-on-surface focus-visible:ring-2 focus-visible:ring-primary"
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
            {step === 1 && (
              <CityStep
                cities={filteredCities}
                search={citySearch}
                onSearchChange={setCitySearch}
                selected={city}
                onSelect={setCity}
                onArrowKey={handleCityArrowKey}
                itemRef={(id, el) => {
                  cityRefs.current[id] = el;
                }}
              />
            )}
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
