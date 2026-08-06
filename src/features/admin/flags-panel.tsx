"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { toggleFeatureFlagAction } from "./flags-actions";
import type { ToggleFlagActionResult } from "./flags-actions";
import { reasonProblem } from "./presenter";

// ===========================================================================
// The toggle control: one per flag row.
//
// Same shape as `./queue-status-panel.tsx#ReplayPanel` and the same reason:
// a flag flip is a privileged, side-effecting, platform-wide action (doc 31
// section 1: "super_admin only"), so it is a client island only because a
// reason has to be typed before anything can be submitted. Nothing here
// optimistically flips the switch - a failure comes back typed and is
// rendered in place, and the switch's own displayed state is the SERVER's
// (via the `isEnabled` prop, refreshed by `revalidatePath` on success), never
// local-only state that could drift from what the database actually holds.
// ===========================================================================

export interface FlagTogglePanelProps {
  flagKey: string;
  isEnabled: boolean;
  /** doc 31 section 1: `/admin/flags` is super_admin only. An `admin` or
   * `support` session renders this read-only, same "assert the refusal, not
   * just the absence of a link" pattern `QueueStatusScreen`'s ReplayPanel
   * uses for its own `canAct`. */
  canAct: boolean;
}

export function FlagTogglePanel({ flagKey, isEnabled, canAct }: FlagTogglePanelProps) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [result, setResult] = React.useState<ToggleFlagActionResult | null>(null);
  const [pending, startTransition] = React.useTransition();

  const target = !isEnabled;

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
      const outcome = await toggleFeatureFlagAction({
        key: flagKey,
        isEnabled: target,
        reason: reason.trim(),
      });
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
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-label-s",
            isEnabled
              ? "bg-secondary-container text-on-secondary-container"
              : "bg-surface-container-high text-on-surface-variant",
          )}
        >
          {isEnabled ? "On" : "Off"}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outlined"
          disabled={!canAct}
          aria-expanded={open}
          onClick={toggle}
        >
          {open ? "Cancel" : `Turn ${target ? "on" : "off"}`}
        </Button>
      </div>

      {open && (
        <div className="flex flex-col gap-2 rounded-md3-sm border border-outline-variant p-3">
          <label htmlFor={`flag-reason-${flagKey}`} className="text-label-m text-on-surface">
            Why are you turning this {target ? "on" : "off"}? Required.
          </label>
          <textarea
            id={`flag-reason-${flagKey}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="What is happening, and who asked for this."
            className={cn(
              "w-full rounded-md3-sm border border-outline bg-surface p-2 text-body-m text-on-surface",
              "outline-none focus-visible:ring-2 focus-visible:ring-primary",
            )}
          />
          <p className="text-body-s text-on-surface-variant">
            Recorded in the audit log as flag.updated. This is a platform-wide
            switch: every receipt, chat and analytics call the switch covers
            starts routing to its documented fallback immediately.
          </p>
          <div>
            <Button
              type="button"
              size="sm"
              variant="filled"
              disabled={pending || reasonInvalid}
              onClick={submit}
            >
              {pending ? "Saving" : `Confirm: turn ${target ? "on" : "off"}`}
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
