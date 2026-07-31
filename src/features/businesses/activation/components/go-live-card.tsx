"use client";

import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { EarningRuleCard } from "@/features/campaigns/components/earning-rule-card";
import { upsertBaseRule } from "@/features/campaigns/actions";
import type { BaseRuleInput } from "@/features/campaigns/schemas";
import type { PointsRuleRow } from "@/features/campaigns/server/types";
import { cn } from "@/lib/utils";

import { submitForReviewAction } from "../actions";
import type { ActivationActionResult } from "../actions";
import { MAX_SUBMISSION_NOTE_LENGTH, submissionNoteProblem } from "../presenter";
import type { ActivationChecklist } from "../presenter";
import type { BusinessStatus } from "../types";

// ===========================================================================
// "What is left before customers can find you."
//
// THE ONE SCREEN THAT CLOSES THE DEAD END. Before this card existed, a merchant
// finished onboarding, saw a working portal, and was invisible to every
// consumer forever with nothing anywhere saying so: `businesses.status`
// defaulted to 'draft', every consumer read filters `status='active'`, and no
// code path in the product moved a business between the two.
//
// A CLIENT ISLAND, and only because two things here are state: the applicant
// note being typed, and the earning-rule editor's own form. Everything that
// decides WHAT to render is computed on the server by ../presenter.ts and
// arrives as props.
//
// ---------------------------------------------------------------------------
// WHY THE EARNING-RULE EDITOR IS EMBEDDED RATHER THAN LINKED.
// ---------------------------------------------------------------------------
// It is the single blocking requirement, and until now it lived only on
// /business/campaigns, behind a screen a new merchant has no reason to open. A
// checklist that says "go somewhere else and do a thing, then come back" is how
// a one-item checklist becomes a two-week gap. `EarningRuleCard` is the exact
// component that screen renders, calling the exact same server action, so there
// is one editor and one save path with two entry points, not two editors.
//
// Nothing here optimistically updates. Submitting for review is a state change
// an admin then acts on, and a card that showed "under review" before the
// server agreed would be telling the merchant something no one had recorded.
// ===========================================================================

export interface GoLiveCardProps {
  status: BusinessStatus;
  checklist: ActivationChecklist;
  /** The admin's decision text, verbatim, when the last round came back. */
  sentBackReason: string | null;
  /** Feeds the embedded editor. Null when no usable base rule is set. */
  baseRule: PointsRuleRow | null;
  /** When the open round was submitted, already formatted. Null when unknown. */
  submittedLabel: string | null;
}

type SaveResult = { ok: true } | { ok: false; message: string };

function ChecklistRow({
  title,
  body,
  done,
  required,
}: {
  title: string;
  body: string;
  done: boolean;
  required: boolean;
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className={cn(
          "material-symbols-rounded mt-0.5 shrink-0 text-[20px]",
          done ? "is-filled text-primary" : "text-on-surface-variant",
        )}
      >
        {done ? "check_circle" : "radio_button_unchecked"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-label-l text-on-surface">{title}</span>
          {required && !done && (
            <span className="inline-flex items-center rounded-full bg-error-container px-2 py-0.5 text-label-s text-on-error-container">
              Required
            </span>
          )}
          {!required && !done && (
            <span className="inline-flex items-center rounded-full bg-surface-container-high px-2 py-0.5 text-label-s text-on-surface-variant">
              Recommended
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-body-s text-on-surface-variant">{body}</span>
      </span>
      <span className="sr-only">{done ? "Done" : "Not done yet"}</span>
    </li>
  );
}

export function GoLiveCard({
  status,
  checklist,
  sentBackReason,
  baseRule,
  submittedLabel,
}: GoLiveCardProps) {
  const [note, setNote] = React.useState("");
  const [result, setResult] = React.useState<ActivationActionResult | null>(null);
  const [pending, startTransition] = React.useTransition();

  const noteProblem = submissionNoteProblem(note);
  const needsEarningRule = checklist.blocking.some((item) => item.id === "earning_rule");

  async function handleSaveBaseRule(input: BaseRuleInput): Promise<SaveResult> {
    const saved = await upsertBaseRule(input);
    return saved.ok ? { ok: true } : { ok: false, message: saved.message };
  }

  function submit(): void {
    if (noteProblem !== null) {
      setResult({ ok: false, code: "INVALID_INPUT", message: noteProblem });
      return;
    }
    startTransition(async () => {
      const outcome = await submitForReviewAction({ note: note.trim() });
      setResult(outcome);
      if (outcome.ok) setNote("");
    });
  }

  // ------------------------------------------------------------ under review
  if (status === "pending_verification") {
    return (
      <section
        aria-labelledby="go-live-heading"
        className="flex flex-col gap-3 rounded-md3-md border border-outline-variant bg-surface p-4"
      >
        <h2 id="go-live-heading" className="text-title-m text-on-surface">
          With the Giya team
        </h2>
        <p className="text-body-m text-on-surface-variant">
          {submittedLabel === null
            ? "Your business is being reviewed."
            : `You sent this for review on ${submittedLabel}.`}{" "}
          There is nothing else to do right now. Keep editing your menu, your
          campaigns and your storefront in the meantime; none of it goes out to
          customers until the review is done.
        </p>
      </section>
    );
  }

  // ------------------------------------------------------------ not trading
  if (status === "suspended" || status === "closed") {
    return (
      <section
        aria-labelledby="go-live-heading"
        className="flex flex-col gap-3 rounded-md3-md border border-outline bg-error-container p-4 text-on-error-container"
      >
        <h2 id="go-live-heading" className="text-title-m">
          Not shown to customers
        </h2>
        <p className="text-body-m">
          {status === "suspended"
            ? "This business is suspended. Giya support can tell you what is needed to lift it."
            : "This business is closed. Nothing here is shown to customers."}
        </p>
      </section>
    );
  }

  // ------------------------------------------------------------ draft
  return (
    <section
      aria-labelledby="go-live-heading"
      className="flex flex-col gap-4 rounded-md3-md border border-outline-variant bg-surface p-4"
    >
      <div>
        <h2 id="go-live-heading" className="text-title-m text-on-surface">
          Before customers can find you
        </h2>
        <p className="text-body-s text-on-surface-variant">
          Your business is not listed on Giya yet. Finish the required item, then
          ask the Giya team to review you.
        </p>
      </div>

      {sentBackReason !== null && (
        <div
          role="note"
          className="flex flex-col gap-1 rounded-md3-sm bg-error-container p-3 text-on-error-container"
        >
          <p className="text-label-l">Your last submission was sent back</p>
          <p className="text-body-m">{sentBackReason}</p>
        </div>
      )}

      <ul className="flex flex-col gap-3">
        {checklist.items.map((item) => (
          <ChecklistRow
            key={item.id}
            title={item.title}
            body={item.body}
            done={item.done}
            required={item.required}
          />
        ))}
      </ul>

      {needsEarningRule ? (
        // The editor itself, right here, because this is the only thing
        // standing between the merchant and a review.
        <EarningRuleCard baseRule={baseRule} onSave={handleSaveBaseRule} />
      ) : (
        <p className="text-body-s text-on-surface-variant">
          You can change how customers earn points any time on{" "}
          <Link
            href="/business/campaigns"
            className="text-primary underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            your campaigns page
          </Link>
          .
        </p>
      )}

      {result !== null && (
        <p
          role="status"
          className={cn(
            "rounded-md3-sm p-3 text-body-s",
            result.ok
              ? "bg-secondary-container text-on-secondary-container"
              : "bg-error-container text-on-error-container",
          )}
        >
          {result.message}
        </p>
      )}

      {checklist.canSubmit ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="activation-note" className="text-label-m text-on-surface">
            Anything the Giya team should know? Optional.
          </label>
          <textarea
            id="activation-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            maxLength={MAX_SUBMISSION_NOTE_LENGTH}
            placeholder="Where your permits are, a branch we should know about, anything unusual."
            className={cn(
              "w-full rounded-md3-sm border border-outline bg-surface p-3 text-body-m text-on-surface",
              "outline-none focus-visible:ring-2 focus-visible:ring-primary",
            )}
          />
          <div>
            <Button
              type="button"
              variant="filled"
              size="touch"
              disabled={pending}
              onClick={submit}
            >
              {pending ? "Sending" : "Send for review"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-body-s text-on-surface-variant">
          The Send for review button appears once the required item above is
          done.
        </p>
      )}
    </section>
  );
}
