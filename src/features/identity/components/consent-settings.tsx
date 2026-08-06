"use client";

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";

import { OptInSwitch } from "@/components/auth/opt-in-switch";

import { saveConsent } from "../actions";
import type { ConsentColumn, ConsentState } from "../consents";
import { GENERIC_FAILURE, reportThrown } from "../messages";

// The one client island on /profile/settings. The page around it stays a server
// component and hands it four booleans; nothing but plain data crosses.
//
// FOUR CONTROLS, FOUR WRITES, ONE COLUMN EACH.
//
// `public.consumers` has carried these four columns since 0002 and 0021 granted
// `authenticated` UPDATE on all four, with a header saying why: "the profile
// settings screen edits them". There was no such screen. This is it.
//
// They are NOT one bundled preference. NPC Circular 2023-04 requires consent to
// be freely given, specific and separate from other consents, so marketing gets
// its own section and its own write, and no toggle here can drag another one
// with it. Each flip is its own call to `saveConsent`, which writes exactly the
// column it was named.
//
// OPTIMISTIC, AND HONEST ABOUT IT. The switch moves the instant it is tapped,
// because a control that waits for a round trip on a Philippine mobile
// connection feels broken. But a failed write puts it BACK: the screen must
// never sit there claiming a state the database does not hold. There is no
// third state and no "saved?" ambiguity - the switch either shows what the
// database has, or it is mid-flight for the one column being written.
//
// THERE IS NO DEFAULT ANYWHERE IN HERE. The values arrive from
// getMyConsents(), which returns a failure rather than four `false`s when the
// read does not work, and the page renders an error instead of this form for
// that case. Rendering a failed read as "all off" would tell somebody their
// consents are off and invite them to flip one, writing over what is really
// stored.

interface ConsentRow {
  /** The `consumers` column this control writes. Nothing else may write it. */
  readonly column: ConsentColumn;
  /** The switch's accessible name. Must be unique on the page. */
  readonly label: string;
  readonly description: string;
}

// Service notifications. push_enabled and email_enabled default TRUE in the
// schema and that is correct: they govern transactional messages - a receipt
// was approved, points are about to expire - not marketing. Flipping those
// defaults would silence transactional messaging for every existing consumer.
const NOTIFICATION_CONSENTS: readonly ConsentRow[] = [
  {
    column: "push_enabled",
    label: "Push notifications",
    description:
      "Alerts on your device when a receipt is approved, a reward is ready, or points are about to expire.",
  },
  {
    column: "email_enabled",
    label: "Email notifications",
    description: "The same updates, sent to your email address instead.",
  },
];

// Location. Gates `receipts.submitted_lat` / `submitted_lng` (0017), which are
// annotated "only if consumers.gps_fraud_opt_in". The label says what it does
// in plain words on purpose: a consent nobody understands is not consent. The
// copy mirrors the privacy policy's "Location data" section.
const LOCATION_CONSENTS: readonly ConsentRow[] = [
  {
    column: "gps_fraud_opt_in",
    label: "Share your location when you scan",
    description:
      "Attaches your location to a receipt only at the moment when you submit a receipt, to help confirm the scan is genuine. Giya never tracks you in the background, and you can turn this off at any time.",
  },
];

// Marketing, alone, in its own section. Separate from the service toggles
// structurally and not only visually, because that separation is the compliance
// requirement, not a layout preference.
const MARKETING_CONSENT: ConsentRow = {
  column: "marketing_opt_in",
  label: "Marketing messages",
  description:
    "Promotions and offers from Giya and the businesses you follow. Always optional. Using Giya does not require you to receive marketing messages, and turning this off never affects your points or rewards.",
};

export interface ConsentSettingsProps {
  readonly consents: ConsentState;
}

export function ConsentSettings({ consents: initial }: ConsentSettingsProps) {
  const reduce = useReducedMotion();

  const [consents, setConsents] = React.useState<ConsentState>(initial);
  const [saving, setSaving] = React.useState<ConsentColumn | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function handleToggle(column: ConsentColumn, next: boolean): Promise<void> {
    // Per COLUMN, not a global busy flag: the four consents are independent, so
    // a slow write on one has no business freezing the other three. What it must
    // stop is a second tap on the SAME column, because two writes racing on one
    // column can land out of order and leave the row holding the value the
    // consumer did not choose last.
    if (saving === column) return;

    const previous = consents[column];

    setConsents((current) => ({ ...current, [column]: next }));
    setSaving(column);
    setError(null);

    try {
      const result = await saveConsent(column, next);

      if (!result.ok) {
        // Put the control back where the database still has it. Leaving it
        // flipped would be the UI stating a preference nobody stored.
        setConsents((current) => ({ ...current, [column]: previous }));
        // `||`, not `??`: a server message of "" is falsy but not nullish, so
        // `??` lets it through and the alert renders an empty box.
        setError(result.message || GENERIC_FAILURE);
      }
    } catch (thrown) {
      setConsents((current) => ({ ...current, [column]: previous }));
      setError(reportThrown(`save consent ${column} threw`, thrown));
    } finally {
      // In `finally`. A throw that skipped this would leave the column wedged
      // as un-retryable with nothing on screen explaining why.
      setSaving(null);
    }
  }

  function renderRow(row: ConsentRow) {
    return (
      <div
        key={row.column}
        className="flex items-start justify-between gap-4 rounded-md3-md border border-outline-variant bg-surface-container p-4"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-label-l text-on-surface">{row.label}</span>
          <span className="text-body-s text-on-surface-variant">{row.description}</span>
        </div>
        <OptInSwitch
          checked={consents[row.column]}
          onChange={(next) => void handleToggle(row.column, next)}
          label={row.label}
        />
      </div>
    );
  }

  return (
    <div className="mt-6 flex flex-col gap-8">
      <section className="flex flex-col gap-3" aria-labelledby="notifications-heading">
        <h2 id="notifications-heading" className="text-title-m text-on-surface">
          Notifications
        </h2>
        <p className="text-body-s text-on-surface-variant">
          Updates about your own activity. These are on by default so you hear about your points.
        </p>
        {NOTIFICATION_CONSENTS.map(renderRow)}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="location-heading">
        <h2 id="location-heading" className="text-title-m text-on-surface">
          Location
        </h2>
        {LOCATION_CONSENTS.map(renderRow)}
      </section>

      {/* Its own section, deliberately. Marketing consent has to be separate
          from every other consent on this screen - see the header. */}
      <section className="flex flex-col gap-3" aria-labelledby="marketing-heading">
        <h2 id="marketing-heading" className="text-title-m text-on-surface">
          Marketing
        </h2>
        {renderRow(MARKETING_CONSENT)}
      </section>

      {/* One alert region for all four. `role="alert"` so it is announced when
          it appears rather than sitting silently below a switch that has just
          sprung back. */}
      {error !== null ? (
        <motion.p
          role="alert"
          initial={reduce ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.2 }}
          className="text-body-s text-error"
        >
          {error}
        </motion.p>
      ) : null}
    </div>
  );
}
