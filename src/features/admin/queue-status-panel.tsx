"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { replayJobAction } from "./queue-status-actions";
import type { ReplayActionResult } from "./queue-status-actions";
import { reasonProblem } from "./presenter";

// ===========================================================================
// The replay control: one per dead-letter row.
//
// Same shape as `./ladder-panel.tsx` and the same reason: replay is a
// privileged, side-effecting action (doc 39, doc 31 §5's "requeue action
// (audited)"), so it is a client island only because a reason has to be
// typed before anything can be submitted. Nothing here optimistically
// updates the row - a failure comes back typed and is rendered in place.
// ===========================================================================

export interface ReplayPanelProps {
  jobId: string;
  /** doc 31 §5: this screen is admin/super_admin only, never support. */
  canAct: boolean;
}

export function ReplayPanel({ jobId, canAct }: ReplayPanelProps) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [result, setResult] = React.useState<ReplayActionResult | null>(null);
  const [pending, startTransition] = React.useTransition();

  function toggle(): void {
    setResult(null);
    setReason("");
    setOpen((current) => !current);
  }

  function submit(): void {
    const problem = reasonProblem(reason);
    if (problem !== null) {
      setResult({ ok: false, code: "REASON_REQUIRED", message: problem });
      return;
    }
    startTransition(async () => {
      const outcome = await replayJobAction({ jobId, reason: reason.trim() });
      setResult(outcome);
      if (outcome.ok) {
        setOpen(false);
        setReason("");
      }
    });
  }

  const reasonInvalid = reasonProblem(reason) !== null;

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        size="sm"
        variant="outlined"
        disabled={!canAct}
        aria-expanded={open}
        onClick={toggle}
      >
        {open ? "Cancel" : "Replay"}
      </Button>

      {open && (
        <div className="flex flex-col gap-2 rounded-md3-sm border border-outline-variant p-3">
          <label htmlFor={`replay-reason-${jobId}`} className="text-label-m text-on-surface">
            Why are you replaying this job? Required.
          </label>
          <textarea
            id={`replay-reason-${jobId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="What was fixed, and how you know it is safe to retry."
            className={cn(
              "w-full rounded-md3-sm border border-outline bg-surface p-2 text-body-m text-on-surface",
              "outline-none focus-visible:ring-2 focus-visible:ring-primary",
            )}
          />
          <p className="text-body-s text-on-surface-variant">
            Recorded in the audit log as job.replayed. This gives the job a fresh
            attempt budget - it does not raise its attempt cap.
          </p>
          <div>
            <Button
              type="button"
              size="sm"
              variant="filled"
              disabled={pending || reasonInvalid}
              onClick={submit}
            >
              {pending ? "Replaying" : "Confirm replay"}
            </Button>
          </div>
        </div>
      )}

      {result !== null && (
        <p
          role="status"
          className={cn(
            "rounded-md3-sm p-2 text-body-s",
            result.ok
              ? "bg-secondary-container text-on-secondary-container"
              : "bg-error-container text-on-error-container",
          )}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
