"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { WizardHeader } from "@/components/business/wizard-header";
import { TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";
import { registerBusiness } from "@/features/identity/actions";
import { createClient } from "@/lib/supabase/client";

const STEP_LABELS = ["Basics", "Location & hours", "Verification"];

const BUSINESS_TYPES = ["Cafe", "Restaurant", "Bakery", "Retail", "Grocery", "Other"];

const REQUIRED_DOCS = [
  "Mayor's Permit",
  "DTI or SEC registration",
  "Valid government ID",
];

// Shared visual treatment for the native <select> and <input type="time">
// controls below. They cannot reuse <TextField> directly (its props type is
// input-only), so this string mirrors TextField's height/border/radius/focus
// classes by hand to keep the two visually identical.
const fieldControlClass = cn(
  "h-12 rounded-md3-xs border border-outline bg-surface px-4 text-body-l text-on-surface",
  "outline-none transition-colors duration-200 ease-standard",
  "focus:border-primary focus:ring-1 focus:ring-primary",
);

function FieldLabel({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="text-label-l text-on-surface">
      {children}
    </label>
  );
}

function BasicsStep({
  name,
  onNameChange,
  businessType,
  onBusinessTypeChange,
  city,
  onCityChange,
}: {
  name: string;
  onNameChange: (value: string) => void;
  businessType: string;
  onBusinessTypeChange: (value: string) => void;
  city: string;
  onCityChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-headline-s text-on-surface">Business basics</h2>
        <p className="text-body-m text-on-surface-variant">
          Tell us about your business so we can set up your loyalty program.
        </p>
      </div>
      <TextField
        id="business-name"
        label="Business name"
        placeholder="e.g. Kape Diaria"
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
      />
      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor="business-type">Business type</FieldLabel>
        <select
          id="business-type"
          value={businessType}
          onChange={(event) => onBusinessTypeChange(event.target.value)}
          className={fieldControlClass}
        >
          <option value="" disabled>
            Select a business type
          </option>
          {BUSINESS_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>
      <TextField
        id="business-city"
        label="City"
        placeholder="e.g. Cebu"
        value={city}
        onChange={(event) => onCityChange(event.target.value)}
      />
    </div>
  );
}

function HoursGroup({
  legend,
  openId,
  openValue,
  onOpenChange,
  closeId,
  closeValue,
  onCloseChange,
}: {
  legend: string;
  openId: string;
  openValue: string;
  onOpenChange: (value: string) => void;
  closeId: string;
  closeValue: string;
  onCloseChange: (value: string) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-md3-md border border-outline-variant p-4">
      <legend className="px-1 text-title-s text-on-surface">{legend}</legend>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor={openId}>Open</FieldLabel>
          <input
            id={openId}
            type="time"
            value={openValue}
            onChange={(event) => onOpenChange(event.target.value)}
            className={fieldControlClass}
          />
        </div>
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor={closeId}>Close</FieldLabel>
          <input
            id={closeId}
            type="time"
            value={closeValue}
            onChange={(event) => onCloseChange(event.target.value)}
            className={fieldControlClass}
          />
        </div>
      </div>
    </fieldset>
  );
}

type HoursState = {
  weekdayOpen: string;
  weekdayClose: string;
  weekendOpen: string;
  weekendClose: string;
};

// ===========================================================================
// WHY THE MAP PICKER IS NOT ON THIS STEP.
//
// The picker (src/features/businesses/settings/components/location-picker.tsx)
// would fit here on paper: this is the step that already asks "where are you".
// It is deliberately not here, for three reasons that compound:
//
//   1. This wizard's whole design premise is that it is SHORT. Doc 32 section 2
//      puts the rest of setup on a post-registration checklist precisely so
//      that registration is three screens and ends at a dashboard. The map pin
//      is already a line item on that checklist ("Store profile - name, type,
//      address, city, lat/lng pin set"), which is the seam that was designed
//      for exactly this.
//   2. The cost is not one field. The picker pulls Leaflet, a stylesheet and a
//      tile fetch onto a route that today ships none of them, and it invites a
//      merchant to pan and zoom - a minute of engagement, on the screen before
//      "Go to dashboard", for a value they cannot see yet because they have no
//      public profile until they are verified.
//   3. There is nowhere to put the answer. `registerBusiness` writes an address
//      STRING; nothing in this flow writes `businesses.lat/lng`, so adding the
//      picker means adding a second write path and a second set of validation,
//      duplicating the fence that ../../../features/businesses/settings already
//      holds.
//
// So: onboarding keeps collecting the address, and the merchant sets the pin in
// settings, where the picker already lives and where a mistake is one edit away
// from being corrected. The copy below points them there rather than leaving
// them to find it. Revisit only if the checklist shows merchants are stalling
// on the pin specifically.
// ===========================================================================

function LocationHoursStep({
  address,
  onAddressChange,
  hours,
  onHourChange,
}: {
  address: string;
  onAddressChange: (value: string) => void;
  hours: HoursState;
  onHourChange: (key: keyof HoursState, value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-headline-s text-on-surface">Location and hours</h2>
        <p className="text-body-m text-on-surface-variant">
          Customers will see this address and schedule on your profile.
        </p>
      </div>
      <TextField
        id="business-address"
        label="Address"
        placeholder="Unit, street, barangay"
        value={address}
        onChange={(event) => onAddressChange(event.target.value)}
      />
      <p className="text-body-s text-on-surface-variant">
        You will drop a pin on the map in Settings once you are set up, so customers get directions
        instead of guessing.
      </p>
      <HoursGroup
        legend="Weekdays"
        openId="weekday-open"
        openValue={hours.weekdayOpen}
        onOpenChange={(value) => onHourChange("weekdayOpen", value)}
        closeId="weekday-close"
        closeValue={hours.weekdayClose}
        onCloseChange={(value) => onHourChange("weekdayClose", value)}
      />
      <HoursGroup
        legend="Weekends"
        openId="weekend-open"
        openValue={hours.weekendOpen}
        onOpenChange={(value) => onHourChange("weekendOpen", value)}
        closeId="weekend-close"
        closeValue={hours.weekendClose}
        onCloseChange={(value) => onHourChange("weekendClose", value)}
      />
    </div>
  );
}

function VerificationStep({
  files,
  onPickFiles,
  onRemoveFile,
  fileInputRef,
}: {
  files: File[];
  onPickFiles: (fileList: FileList | null) => void;
  onRemoveFile: (index: number) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-headline-s text-on-surface">Verification documents</h2>
        <p className="text-body-m text-on-surface-variant">
          We review documents within a few days. You can explore your dashboard while you wait.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            "flex w-full flex-col items-center gap-3 rounded-md3-lg border-2 border-dashed border-outline bg-surface px-6 py-10 text-center",
            "outline-none transition-colors duration-200 ease-standard hover:bg-surface-container",
            "focus-visible:ring-2 focus-visible:ring-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
          )}
        >
          <span
            aria-hidden
            className="flex size-12 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container"
          >
            <span className="material-symbols-rounded text-[24px]">upload_file</span>
          </span>
          <span className="text-label-l text-on-surface">Drag files or tap to choose</span>
          <span className="text-body-s text-on-surface-variant">PDF, JPG, or PNG</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
          onChange={(event) => onPickFiles(event.target.files)}
        />

        {files.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {files.map((file, index) => (
              <li
                key={`${file.name}-${index}`}
                className="flex items-center justify-between gap-3 rounded-md3-sm border border-outline-variant bg-surface px-4 py-3"
              >
                <span className="flex min-w-0 items-center gap-2 text-body-m text-on-surface">
                  <span
                    aria-hidden
                    className="material-symbols-rounded shrink-0 text-[18px] text-on-surface-variant"
                  >
                    description
                  </span>
                  <span className="truncate">{file.name}</span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => onRemoveFile(index)}
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant",
                    "outline-none transition-colors duration-200 ease-standard hover:bg-surface-container-high",
                    "focus-visible:ring-2 focus-visible:ring-secondary",
                  )}
                >
                  <span aria-hidden className="material-symbols-rounded text-[18px]">
                    close
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-label-l text-on-surface">Required documents</span>
        {REQUIRED_DOCS.map((doc) => (
          <div
            key={doc}
            className="flex items-center gap-3 rounded-md3-sm border border-outline-variant bg-surface px-4 py-3"
          >
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container"
            >
              <span className="material-symbols-rounded text-[16px]">description</span>
            </span>
            <span className="flex-1 text-body-m text-on-surface">{doc}</span>
            <span className="text-body-s text-on-surface-variant">Required</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function BusinessOnboardingPage() {
  const router = useRouter();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [step, setStep] = React.useState(0);

  // Step 1: basics
  const [name, setName] = React.useState("");
  const [businessType, setBusinessType] = React.useState("");
  const [city, setCity] = React.useState("");

  // Step 2: location and hours
  const [address, setAddress] = React.useState("");
  const [hours, setHours] = React.useState<HoursState>({
    weekdayOpen: "09:00",
    weekdayClose: "18:00",
    weekendOpen: "09:00",
    weekendClose: "15:00",
  });

  // Step 3: verification
  const [files, setFiles] = React.useState<File[]>([]);

  // Hours now reach `businesses.opening_hours` (see `finish` below). Documents
  // are still a client-side list and still go nowhere: the `business_documents`
  // TABLE exists and is writable by an owner, but the private
  // `business-documents` BUCKET the rows are supposed to point at was never
  // created on this project - 0019 created `receipts`, 0064 created `avatars`,
  // and nothing ever created this one. Uploading needs a migration G1 does not
  // have; see .superpowers/sdd/briefs/g1-onboarding-report.md.
  // TODO(api): upload documents once the business-documents bucket exists

  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  function handleHourChange(key: keyof HoursState, value: string) {
    setHours((prev) => ({ ...prev, [key]: value }));
  }

  function handlePickFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    // TODO(api): replace mock (no real upload; client-side list only)
    setFiles((prev) => [...prev, ...Array.from(fileList)]);
  }

  function handleRemoveFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  const step1Complete = name.trim() !== "" && businessType !== "" && city.trim() !== "";
  const canContinue = step !== 0 || step1Complete;
  const isLastStep = step === STEP_LABELS.length - 1;

  async function finish() {
    // Guards against the Finish button firing the RPC twice (verified
    // live: a fast double click/tap can invoke this handler again before
    // React commits the `disabled` attribute from the first call).
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    const result = await registerBusiness({
      name,
      type: businessType,
      city,
      address,
      // The four times from step 2, expanded to the seven rows
      // `businesses.opening_hours` stores by the action's own
      // `toOpeningHoursEntries`. They used to stop here.
      hours,
    });
    if (!result.ok) {
      setSubmitting(false);
      setError(result.message);
      return;
    }
    if (!result.hoursSaved) {
      // The business exists, so the merchant goes on to the dashboard either
      // way. Saying so beats a silent drop, and Settings is one screen away.
      console.error("[onboarding] the business was created but its hours were not saved");
    }
    // Refresh the session before navigating so the client picks up a fresh
    // token once the custom access token hook is enabled and stamps `biz`
    // claims for the business just registered; the token issued at
    // sign-up/sign-in predates this business_staff row and won't carry it.
    const supabase = createClient();
    await supabase.auth.refreshSession();
    // Into the portal, which is what the button has always said. This used to
    // push to /business/pending-approval - a waiting room offering a "check
    // status" button and no way to do anything - and that was the real lockout
    // for an unapproved merchant. The portal layout's own approval guard could
    // never fire (see its comment), so this line was the only thing actually
    // keeping a brand new `draft` business out of the product it just signed up
    // for. A business builds its profile, menu, promos and rewards WHILE it
    // waits for review; only its public storefront waits on approval.
    router.push("/business/dashboard");
  }

  function goNext() {
    if (isLastStep) {
      void finish();
      return;
    }
    setStep((s) => Math.min(STEP_LABELS.length - 1, s + 1));
  }

  function goBack() {
    setStep((s) => Math.max(0, s - 1));
  }

  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10">
      <Link
        href="/"
        aria-label="Giya home"
        className="mb-8 rounded-md3-sm text-secondary outline-none focus-visible:ring-2 focus-visible:ring-secondary"
      >
        <Logo variant="lockup" />
      </Link>

      <div className="flex w-full max-w-lg flex-col gap-8">
        <WizardHeader steps={STEP_LABELS} activeIndex={step} />

        {step === 0 && (
          <BasicsStep
            name={name}
            onNameChange={setName}
            businessType={businessType}
            onBusinessTypeChange={setBusinessType}
            city={city}
            onCityChange={setCity}
          />
        )}
        {step === 1 && (
          <LocationHoursStep
            address={address}
            onAddressChange={setAddress}
            hours={hours}
            onHourChange={handleHourChange}
          />
        )}
        {step === 2 && (
          <VerificationStep
            files={files}
            onPickFiles={handlePickFiles}
            onRemoveFile={handleRemoveFile}
            fileInputRef={fileInputRef}
          />
        )}

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
            variant={isLastStep ? "filled" : "tonal"}
            size="touch"
            className="flex-1"
            disabled={!canContinue || submitting}
            onClick={goNext}
          >
            {isLastStep ? (submitting ? "Setting up..." : "Go to dashboard") : "Continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
