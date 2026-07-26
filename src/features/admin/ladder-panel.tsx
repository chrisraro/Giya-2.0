"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  applyCooldownAction,
  clawbackAction,
  liftCooldownAction,
  suspendAction,
  unsuspendAction,
} from "./actions";
import type { AdminActionResult } from "./actions";
import { LADDER_COPY, clawbackCopy, cooldownState, reasonProblem } from "./presenter";
import type { LadderAction } from "./presenter";
import type { ClawbackEligibility, ConsumerStandingView } from "./types";

// ===========================================================================
// The consequences-ladder controls: the only client island in this portal.
//
// It is a client component for one reason - a reason has to be typed before
// anything can be submitted, and "typed" is state. Everything else on these
// screens is a server component.
//
// ---------------------------------------------------------------------------
// THE REASON IS THE INTERACTION, NOT A FIELD ON IT.
// ---------------------------------------------------------------------------
// Doc 31 §11: "any write touching tenant/user data blocks submission until a
// reason is entered". So there is no button that acts. Every button OPENS a
// panel; the panel states what is about to happen in full sentences, takes the
// reason, and only then offers the control that does it. That ordering is the
// whole design: an operator who has to describe why before they can act has
// already thought about whether they should, and the text they wrote is the
// thing an investigation six months from now will actually read.
//
// The check here is a courtesy, not the enforcement. `reasonProblem` is the
// same function the server action's service calls, and underneath both sits
// `audit_logs_admin_reason_required`, a database check constraint that no
// caller can bypass. This layer exists so nobody types four paragraphs of
// evidence and loses them to a 23514.
//
// Every action is a form submission through a server action, so a failure comes
// back as a typed result and is rendered in place. Nothing here optimistically
// updates: these actions move money and lock accounts, and a UI that shows
// success before the server agreed would be lying about both.
// ===========================================================================

type ActionRunner = (input: unknown) => Promise<AdminActionResult>;

interface Available {
  action: LadderAction;
  run: ActionRunner;
  payload: Record<string, string>;
  /** Set when the action exists but cannot be taken; explains why, in place. */
  blockedReason: string | null;
}

export interface LadderPanelProps {
  receiptId: string;
  consumerId: string;
  consumerName: string | null;
  standing: ConsumerStandingView;
  clawback: ClawbackEligibility;
  /** doc 01's matrix: a `support` admin sees this panel and can operate none of it. */
  canAct: boolean;
  /** Injected so the cooldown clock renders identically on server and client. */
  now: Date;
}

export function LadderPanel({
  receiptId,
  consumerId,
  consumerName,
  standing,
  clawback,
  canAct,
  now,
}: LadderPanelProps) {
  const [open, setOpen] = React.useState<LadderAction | null>(null);
  const [reason, setReason] = React.useState("");
  const [result, setResult] = React.useState<AdminActionResult | null>(null);
  const [pending, startTransition] = React.useTransition();

  const cooldown = cooldownState(standing.scanBlockedUntil, now);
  const clawbackView = clawbackCopy(clawback);

  const available: Available[] = [
    cooldown.active
      ? {
          action: "cooldown_lift",
          run: liftCooldownAction,
          payload: { consumerId },
          blockedReason: null,
        }
      : {
          action: "cooldown_apply",
          run: applyCooldownAction,
          payload: { consumerId },
          blockedReason: null,
        },
    standing.isSuspended
      ? { action: "unsuspend", run: unsuspendAction, payload: { profileId: consumerId }, blockedReason: null }
      : { action: "suspend", run: suspendAction, payload: { profileId: consumerId }, blockedReason: null },
    {
      action: "clawback",
      run: clawbackAction,
      payload: { receiptId },
      blockedReason: clawbackView.available ? null : clawbackView.summary,
    },
  ];

  function toggle(action: LadderAction): void {
    setResult(null);
    setReason("");
    setOpen((current) => (current === action ? null : action));
  }

  function submit(entry: Available): void {
    const problem = reasonProblem(reason);
    if (problem !== null) {
      setResult({ ok: false, code: "REASON_REQUIRED", message: problem });
      return;
    }
    startTransition(async () => {
      const outcome = await entry.run({ ...entry.payload, reason: reason.trim() });
      setResult(outcome);
      if (outcome.ok) {
        setOpen(null);
        setReason("");
      }
    });
  }

  const subject = consumerName ?? "this customer";
  const reasonInvalid = reasonProblem(reason) !== null;

  return (
    <section
      aria-labelledby="ladder-heading"
      className="flex flex-col gap-4 rounded-md3-md border border-outline-variant bg-surface p-4"
    >
      <div>
        <h2 id="ladder-heading" className="text-title-m text-on-surface">
          Consequences
        </h2>
        <p className="text-body-s text-on-surface-variant">
          Each of these is recorded against your name with the reason you give.
          They apply to {subject} across the whole platform, not to one business.
        </p>
      </div>

      {!canAct && (
        <p
          role="note"
          className="rounded-md3-sm border border-outline bg-surface-container p-3 text-body-s text-on-surface"
        >
          Your account is read-only. You can see everything on this page and take
          none of these actions.
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

      <ul className="flex flex-col gap-3">
        {available.map((entry) => {
          const copy = LADDER_COPY[entry.action];
          const isOpen = open === entry.action;
          const disabled = !canAct || entry.blockedReason !== null;

          return (
            <li
              key={entry.action}
              className="flex flex-col gap-2 rounded-md3-sm border border-outline-variant p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-label-l text-on-surface">{copy.label}</span>
                <Button
                  type="button"
                  size="sm"
                  variant={copy.destructive ? "outlined" : "tonal"}
                  disabled={disabled}
                  aria-expanded={isOpen}
                  onClick={() => toggle(entry.action)}
                  className={cn(copy.destructive && "border-error text-error")}
                >
                  {isOpen ? "Cancel" : copy.label}
                </Button>
              </div>

              <p className="text-body-s text-on-surface-variant">
                {entry.blockedReason ?? copy.description}
              </p>

              {isOpen && (
                <div className="flex flex-col gap-2">
                  <label
                    htmlFor={`reason-${entry.action}`}
                    className="text-label-m text-on-surface"
                  >
                    Why are you doing this? Required.
                  </label>
                  <textarea
                    id={`reason-${entry.action}`}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    rows={3}
                    maxLength={1000}
                    placeholder="What did you find, and where. This is the record."
                    className={cn(
                      "w-full rounded-md3-sm border border-outline bg-surface p-3 text-body-m text-on-surface",
                      "outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    )}
                  />
                  <p className="text-body-s text-on-surface-variant">
                    Recorded in the audit log as {copy.auditAction}.
                  </p>
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      variant={copy.destructive ? "filled" : "tonal"}
                      disabled={pending || reasonInvalid}
                      onClick={() => submit(entry)}
                      className={cn(copy.destructive && "bg-error text-on-error")}
                    >
                      {pending ? "Working" : `Confirm: ${copy.label.toLowerCase()}`}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
