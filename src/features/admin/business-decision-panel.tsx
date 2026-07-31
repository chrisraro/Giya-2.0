"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { approveBusinessAction, sendBusinessBackAction } from "./business-actions";
import type { BusinessActionResult } from "./business-actions";
import { MAX_REASON_LENGTH, reasonProblem } from "./presenter";

// ===========================================================================
// Approve, or send back. The only client island on the verification queue.
//
// ---------------------------------------------------------------------------
// THE REASON IS THE INTERACTION, NOT A FIELD ON IT.
// ---------------------------------------------------------------------------
// The same rule ./ladder-panel.tsx states for the consequences ladder, and the
// same doc line behind it (doc 31 section 11: "any write touching tenant/user
// data blocks submission until a reason is entered"). There is no button that
// decides. Each button OPENS a panel; the panel says what is about to happen in
// full sentences, takes the reason, and only then offers the control that does
// it.
//
// ONE DIFFERENCE FROM THE LADDER, AND IT IS IMPORTANT ENOUGH TO SAY ON SCREEN:
// the send-back reason is read by the MERCHANT, verbatim, on their dashboard
// (`business_verifications.decision_reason`, doc 32 section 2.2). Every other
// admin reason in this product is internal and may name other tenants. An
// operator who thinks they are writing an internal note writes a different
// sentence from one who knows the applicant reads it, so the label says which
// this is.
//
// Nothing here optimistically updates. Approving a business makes it visible to
// every consumer on the platform; a UI that showed success before the server
// agreed would be lying about that.
// ===========================================================================

type Decision = "approve" | "send_back";

const COPY: Record<
  Decision,
  { label: string; description: string; reasonLabel: string; reasonHint: string; destructive: boolean }
> = {
  approve: {
    label: "Approve",
    description:
      "Lists this business on Giya. Customers can find it, scan for it and earn points at it from the moment you press this.",
    reasonLabel: "Why are you approving this? Required.",
    reasonHint:
      "Internal. Recorded in the audit log against your name. The merchant does not see this.",
    destructive: false,
  },
  send_back: {
    label: "Send back",
    description:
      "Returns this business to draft so the owner can fix things and submit again. They stay unlisted in the meantime.",
    reasonLabel: "What do they need to fix? Required.",
    reasonHint:
      "THE MERCHANT READS THIS WORD FOR WORD on their dashboard. Write it to them, not about them.",
    destructive: true,
  },
};

export interface BusinessDecisionPanelProps {
  businessId: string;
  businessName: string;
  /** doc 01's matrix: a `support` admin sees this panel and can operate none of it. */
  canAct: boolean;
  /**
   * Null when the merchant has no usable earning rule. The approve control is
   * disabled and says why, because `activate_business` would refuse it anyway
   * and an admin should not have to type a reason to find that out.
   */
  earningRule: string | null;
}

export function BusinessDecisionPanel({
  businessId,
  businessName,
  canAct,
  earningRule,
}: BusinessDecisionPanelProps) {
  const [open, setOpen] = React.useState<Decision | null>(null);
  const [reason, setReason] = React.useState("");
  const [result, setResult] = React.useState<BusinessActionResult | null>(null);
  const [pending, startTransition] = React.useTransition();

  const reasonInvalid = reasonProblem(reason) !== null;
  const approveBlocked = earningRule === null;

  function toggle(decision: Decision): void {
    setResult(null);
    setReason("");
    setOpen((current) => (current === decision ? null : decision));
  }

  function submit(decision: Decision): void {
    const problem = reasonProblem(reason);
    if (problem !== null) {
      setResult({ ok: false, code: "REASON_REQUIRED", message: problem });
      return;
    }
    startTransition(async () => {
      const run = decision === "approve" ? approveBusinessAction : sendBusinessBackAction;
      const outcome = await run({ businessId, reason: reason.trim() });
      setResult(outcome);
      if (outcome.ok) {
        setOpen(null);
        setReason("");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {!canAct && (
        <p
          role="note"
          className="rounded-md3-sm border border-outline bg-surface-container p-3 text-body-s text-on-surface"
        >
          Your account is read-only. You can see everything about {businessName} and
          decide nothing.
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

      <div className="flex flex-wrap gap-2">
        {(["approve", "send_back"] as const).map((decision) => {
          const copy = COPY[decision];
          const isOpen = open === decision;
          const blocked = decision === "approve" && approveBlocked;

          return (
            <Button
              key={decision}
              type="button"
              size="sm"
              variant={copy.destructive ? "outlined" : "tonal"}
              disabled={!canAct || blocked}
              aria-expanded={isOpen}
              onClick={() => toggle(decision)}
              className={cn(copy.destructive && "border-error text-error")}
            >
              {isOpen ? "Cancel" : copy.label}
            </Button>
          );
        })}
      </div>

      {approveBlocked && (
        <p className="text-body-s text-error">
          Approving is not available: this business has no earning rule, so its
          receipts would be approved and award nothing, and its customers would
          be told nothing. Giya refuses the activation until the owner sets one.
        </p>
      )}

      {open !== null && (
        <div className="flex flex-col gap-2 rounded-md3-sm border border-outline-variant p-3">
          <p className="text-body-s text-on-surface-variant">{COPY[open].description}</p>
          <label htmlFor={`reason-${businessId}-${open}`} className="text-label-m text-on-surface">
            {COPY[open].reasonLabel}
          </label>
          <textarea
            id={`reason-${businessId}-${open}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={MAX_REASON_LENGTH}
            placeholder={
              open === "approve"
                ? "What you checked, and where."
                : "What is wrong and what they should do about it."
            }
            className={cn(
              "w-full rounded-md3-sm border border-outline bg-surface p-3 text-body-m text-on-surface",
              "outline-none focus-visible:ring-2 focus-visible:ring-primary",
            )}
          />
          <p className="text-body-s text-on-surface-variant">{COPY[open].reasonHint}</p>
          <div>
            <Button
              type="button"
              size="sm"
              variant={COPY[open].destructive ? "filled" : "tonal"}
              disabled={pending || reasonInvalid}
              onClick={() => submit(open)}
              className={cn(COPY[open].destructive && "bg-error text-on-error")}
            >
              {pending ? "Working" : `Confirm: ${COPY[open].label.toLowerCase()}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
