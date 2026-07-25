"use client";

import * as React from "react";
import { useForm, useWatch, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { TextField } from "@/components/ui/text-field";
import { cn } from "@/lib/utils";

import { saveBusinessProfile } from "../actions";
import {
  ADDRESS_FIELD_MAX_LENGTH,
  BUSINESS_DESCRIPTION_MAX_LENGTH,
  BUSINESS_NAME_MAX_LENGTH,
  BUSINESS_NAME_MIN_LENGTH,
  CONTACT_FIELD_MAX_LENGTH,
  POSTAL_CODE_MAX_LENGTH,
} from "../schemas";
import { WEEKDAY_LABELS } from "../hours";
import type { BusinessProfileView } from "../types";

// The whole editable surface of `/business/settings`, in one form. Every field
// here is a presentation field; see ../schemas.ts for the list of columns this
// screen deliberately cannot write and why each one is excluded.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const optionalUrlField = z
  .string()
  .trim()
  .max(CONTACT_FIELD_MAX_LENGTH)
  .refine((value) => value === "" || /^https?:\/\/\S+$/.test(value), {
    message: "Links must start with http:// or https://",
  });

const settingsFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(BUSINESS_NAME_MIN_LENGTH, "Your business needs a name")
    .max(BUSINESS_NAME_MAX_LENGTH, `Keep the name under ${BUSINESS_NAME_MAX_LENGTH} characters`),
  description: z.string().max(BUSINESS_DESCRIPTION_MAX_LENGTH),
  phone: z.string().trim().max(CONTACT_FIELD_MAX_LENGTH),
  email: z
    .string()
    .trim()
    .max(CONTACT_FIELD_MAX_LENGTH)
    .refine((value) => value === "" || z.email().safeParse(value).success, {
      message: "Enter a valid email address",
    }),
  website: optionalUrlField,
  facebook: optionalUrlField,
  instagram: optionalUrlField,
  tiktok: optionalUrlField,
  addressLine: z.string().trim().max(ADDRESS_FIELD_MAX_LENGTH),
  barangay: z.string().trim().max(ADDRESS_FIELD_MAX_LENGTH),
  postalCode: z.string().trim().max(POSTAL_CODE_MAX_LENGTH),
  hours: z.array(
    z.object({
      day: z.number().int().min(1).max(7),
      open: z.string().regex(HHMM, "Use a 24-hour time like 09:00"),
      close: z.string().regex(HHMM, "Use a 24-hour time like 21:00"),
      closed: z.boolean(),
    }),
  ),
});

type SettingsFormValues = z.infer<typeof settingsFormSchema>;

export interface SettingsFormProps {
  profile: BusinessProfileView;
}

const STATUS_COPY: Record<string, string> = {
  draft: "Draft. Finish your setup, then submit your documents to get verified.",
  pending_verification: "Waiting on verification. We will let you know as soon as it is decided.",
  active: "Verified and live.",
  suspended: "Suspended. Contact support.",
  closed: "Closed.",
};

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card variant="outlined" className="flex flex-col gap-4 p-4 sm:p-6">
      <h2 className="text-title-m text-on-surface">{title}</h2>
      {children}
    </Card>
  );
}

export function SettingsForm({ profile }: SettingsFormProps) {
  const [submitting, setSubmitting] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const {
    register,
    control,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: {
      name: profile.name,
      description: profile.description ?? "",
      phone: profile.phone ?? "",
      email: profile.email ?? "",
      website: profile.website ?? "",
      facebook: profile.socials.facebook ?? "",
      instagram: profile.socials.instagram ?? "",
      tiktok: profile.socials.tiktok ?? "",
      addressLine: profile.addressLine ?? "",
      barangay: profile.barangay ?? "",
      postalCode: profile.postalCode ?? "",
      hours: profile.openingHours,
    },
  });

  const hours = useWatch({ control, name: "hours" });

  const submit: SubmitHandler<SettingsFormValues> = async (values) => {
    setSubmitting(true);
    setServerError(null);
    setSaved(false);

    // Named keys, never a spread: the payload is exactly the schema's strict
    // shape, so there is no path by which an extra field rides along.
    const result = await saveBusinessProfile({
      name: values.name,
      description: values.description,
      phone: values.phone,
      email: values.email,
      website: values.website,
      facebook: values.facebook,
      instagram: values.instagram,
      tiktok: values.tiktok,
      addressLine: values.addressLine,
      barangay: values.barangay,
      postalCode: values.postalCode,
      openingHours: values.hours,
    });

    setSubmitting(false);
    if (!result.ok) {
      setServerError(result.message);
      return;
    }
    setSaved(true);
  };

  /** Doc 32 section 4's copy-to-all-days affordance. */
  function copyMondayToAll() {
    const monday = getValues("hours.0");
    if (!monday) return;
    for (let index = 1; index < 7; index += 1) {
      setValue(`hours.${index}.open`, monday.open, { shouldDirty: true });
      setValue(`hours.${index}.close`, monday.close, { shouldDirty: true });
      setValue(`hours.${index}.closed`, monday.closed, { shouldDirty: true });
    }
  }

  return (
    <form onSubmit={handleSubmit(submit)} noValidate className="flex flex-col gap-6">
      <div>
        <h1 className="text-headline-s text-on-surface">Settings</h1>
        <p className="text-body-s text-on-surface-variant">
          How your store appears to customers in the app
        </p>
      </div>

      <Card variant="filled" className="flex flex-col gap-1 p-4">
        <p className="text-title-s text-on-surface">giya.ph/{profile.readOnly.slug}</p>
        <p className="text-body-s text-on-surface-variant">
          {STATUS_COPY[profile.readOnly.status] ?? profile.readOnly.status}
        </p>
        <p className="text-body-s text-on-surface-variant">
          Your web address, your verification status and your plan are set by Giya, so they are not
          editable here.
        </p>
      </Card>

      <SectionCard title="Your business">
        <TextField
          id="settings-name"
          label="Business name"
          {...(errors.name?.message ? { errorText: errors.name.message } : {})}
          {...register("name")}
        />
        <div className="flex flex-col gap-2">
          <label htmlFor="settings-description" className="text-label-l text-on-surface">
            Description
          </label>
          <textarea
            id="settings-description"
            rows={3}
            placeholder="A sentence customers would recognise you by"
            className={cn(
              "rounded-md3-xs border border-outline bg-surface px-4 py-3 text-body-l text-on-surface",
              "outline-none transition-colors duration-200 ease-standard",
              "focus:border-primary focus:ring-1 focus:ring-primary",
            )}
            {...register("description")}
          />
        </div>
      </SectionCard>

      <SectionCard title="How customers reach you">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            id="settings-phone"
            label="Phone"
            inputMode="tel"
            {...(errors.phone?.message ? { errorText: errors.phone.message } : {})}
            {...register("phone")}
          />
          <TextField
            id="settings-email"
            label="Email"
            inputMode="email"
            {...(errors.email?.message ? { errorText: errors.email.message } : {})}
            {...register("email")}
          />
        </div>
        <TextField
          id="settings-website"
          label="Website"
          placeholder="https://"
          {...(errors.website?.message ? { errorText: errors.website.message } : {})}
          {...register("website")}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <TextField
            id="settings-facebook"
            label="Facebook"
            placeholder="https://"
            {...(errors.facebook?.message ? { errorText: errors.facebook.message } : {})}
            {...register("facebook")}
          />
          <TextField
            id="settings-instagram"
            label="Instagram"
            placeholder="https://"
            {...(errors.instagram?.message ? { errorText: errors.instagram.message } : {})}
            {...register("instagram")}
          />
          <TextField
            id="settings-tiktok"
            label="TikTok"
            placeholder="https://"
            {...(errors.tiktok?.message ? { errorText: errors.tiktok.message } : {})}
            {...register("tiktok")}
          />
        </div>
      </SectionCard>

      <SectionCard title="Where you are">
        <TextField
          id="settings-address-line"
          label="Street address"
          {...(errors.addressLine?.message ? { errorText: errors.addressLine.message } : {})}
          {...register("addressLine")}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            id="settings-barangay"
            label="Barangay"
            {...(errors.barangay?.message ? { errorText: errors.barangay.message } : {})}
            {...register("barangay")}
          />
          <TextField
            id="settings-postal-code"
            label="Postal code"
            inputMode="numeric"
            {...(errors.postalCode?.message ? { errorText: errors.postalCode.message } : {})}
            {...register("postalCode")}
          />
        </div>
        <p className="text-body-s text-on-surface-variant">
          Your city and your exact map pin are set from the map picker, which is coming with the
          store profile screen.
        </p>
      </SectionCard>

      <SectionCard title="Opening hours">
        <p className="text-body-s text-on-surface-variant">
          Customers see these, and so does the assistant that answers &ldquo;are they open?&rdquo;.
          Times are
          Philippine time, and a closing time before the opening time means you close after
          midnight.
        </p>
        <ul className="flex flex-col gap-3">
          {(hours ?? profile.openingHours).map((entry, index) => (
            <li
              key={entry.day}
              className="flex flex-wrap items-center gap-3 border-b border-outline-variant pb-3 last:border-b-0 last:pb-0"
            >
              <span className="w-24 shrink-0 text-body-m text-on-surface">
                {WEEKDAY_LABELS[entry.day - 1]}
              </span>
              <label className="flex items-center gap-2 text-body-s text-on-surface-variant">
                <input
                  type="checkbox"
                  className="size-4 rounded border-outline"
                  {...register(`hours.${index}.closed`)}
                />
                Closed
              </label>
              <input type="hidden" {...register(`hours.${index}.day`, { valueAsNumber: true })} />
              <label className="flex items-center gap-2 text-body-s text-on-surface-variant">
                <span className="sr-only">{WEEKDAY_LABELS[entry.day - 1]} opening time</span>
                <input
                  type="time"
                  disabled={entry.closed}
                  className="h-10 rounded-md3-xs border border-outline bg-surface px-3 text-body-m text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  {...register(`hours.${index}.open`)}
                />
              </label>
              <span className="text-body-s text-on-surface-variant">to</span>
              <label className="flex items-center gap-2 text-body-s text-on-surface-variant">
                <span className="sr-only">{WEEKDAY_LABELS[entry.day - 1]} closing time</span>
                <input
                  type="time"
                  disabled={entry.closed}
                  className="h-10 rounded-md3-xs border border-outline bg-surface px-3 text-body-m text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  {...register(`hours.${index}.close`)}
                />
              </label>
            </li>
          ))}
        </ul>
        <div>
          <Button type="button" variant="text" size="sm" onClick={copyMondayToAll}>
            Copy Monday to every day
          </Button>
        </div>
      </SectionCard>

      {serverError ? (
        <p role="alert" className="text-body-s text-error">
          {serverError}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-body-s text-on-surface-variant">
          Saved.
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button type="submit" variant="filled" size="touch" disabled={submitting}>
          {submitting ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
