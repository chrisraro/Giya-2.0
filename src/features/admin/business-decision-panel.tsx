"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { approveBusinessAction, deleteBusinessAction, sendBusinessBackAction } from "./business-actions";
import type { BusinessActionResult } from "./business-actions";
import { MAX_REASON_LENGTH, reasonProblem } from "./presenter";

type Decision = "approve" | "send_back" | "delete";

const COPY: Record<
  Decision,
  { label: string; description: string; reasonLabel: string; reasonHint: string; destructive: boolean }
> = {
  approve: {
    label: "Approve",
    description:
      "Activates this business account. The merchant can access their portal dashboard and complete onboarding.",
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
  delete: {
    label: "Delete / Purge",
    description:
      "PERMANENTLY PURGES this business and all related child data (receipts, transactions, products, campaigns, rewards, staff). THIS CANNOT BE UNDONE.",
    reasonLabel: "Why are you purging this business? Required.",
    reasonHint:
      "Internal. Recorded in the platform audit log against your admin account.",
    destructive: true,
  },
};

export interface BusinessDecisionPanelProps {
  businessId: string;
  businessName: string;
  canAct: boolean;
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
      const fn =
        decision === "approve"
          ? approveBusinessAction
          : decision === "send_back"
            ? sendBusinessBackAction
            : deleteBusinessAction;
      const res = await fn({ businessId, reason });
      setResult(res);
      if (res.ok) {
        setOpen(null);
        setReason("");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {(["approve", "send_back", "delete"] as const).map((decision) => {
          const copy = COPY[decision];
          const isOpen = open === decision;

          return (
            <Button
              key={decision}
              type="button"
              size="sm"
              variant={copy.destructive ? "outlined" : "tonal"}
              disabled={!canAct}
              aria-expanded={isOpen}
              onClick={() => toggle(decision)}
              className={cn(copy.destructive && "border-error text-error")}
            >
              {isOpen ? "Cancel" : copy.label}
            </Button>
          );
        })}
      </div>

      {!canAct && (
        <p className="text-body-s text-on-surface-variant">
          Your account role is read-only. Support accounts can view merchant applications but cannot approve or send them back.
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
            disabled={pending}
            maxLength={MAX_REASON_LENGTH}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full rounded-md3-xs border border-outline bg-surface p-2 text-body-m text-on-surface outline-none focus-visible:ring-2 focus-visible:ring-primary"
            placeholder={COPY[open].destructive ? "e.g. Please update your business registration documents." : "e.g. Verified business signup and owner credentials."}
          />
          <p className="text-label-s text-on-surface-variant">{COPY[open].reasonHint}</p>

          {result !== null && !result.ok && (
            <div role="alert" className="text-body-s text-error">
              {result.message}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="text"
              disabled={pending}
              onClick={() => setOpen(null)}
            >
              Cancel
            </Button>

            <Button
              type="button"
              size="sm"
              variant={COPY[open].destructive ? "outlined" : "filled"}
              disabled={!canAct || reasonInvalid || pending}
              onClick={() => submit(open)}
              className={cn(COPY[open].destructive && "border-error text-error")}
            >
              {pending ? "Saving..." : `Confirm ${COPY[open].label.toLowerCase()}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
