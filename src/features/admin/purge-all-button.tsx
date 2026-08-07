"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

import { purgeAllBusinessesAction } from "./business-actions";
import type { BusinessActionResult } from "./business-actions";
import { MAX_REASON_LENGTH, reasonProblem } from "./presenter";

export function PurgeAllBusinessesButton({ canAct }: { canAct: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [result, setResult] = React.useState<BusinessActionResult | null>(null);
  const [pending, startTransition] = React.useTransition();

  const reasonInvalid = reasonProblem(reason) !== null;

  function handleOpen() {
    setResult(null);
    setReason("Reset platform test data to start fresh");
    setOpen(true);
  }

  function handleClose() {
    if (pending) return;
    setOpen(false);
    setResult(null);
    setReason("");
  }

  function handleConfirm() {
    const problem = reasonProblem(reason);
    if (problem !== null) {
      setResult({ ok: false, code: "REASON_REQUIRED", message: problem });
      return;
    }

    startTransition(async () => {
      const res = await purgeAllBusinessesAction({ reason });
      setResult(res);
      if (res.ok) {
        setOpen(false);
        setReason("");
      }
    });
  }

  if (!canAct) return null;

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outlined"
        onClick={handleOpen}
        className="border-error text-error hover:bg-error-container/30"
      >
        <span className="material-symbols-rounded text-[18px]">delete_sweep</span>
        <span>Clear / Purge All Data</span>
      </Button>

      <Dialog open={open} onClose={handleClose} title="Purge All Businesses & Transactions">
        <div className="flex flex-col gap-4">
          <p className="text-body-m text-on-surface">
            Are you sure you want to permanently clear <strong className="text-error">ALL businesses, transactions, receipts, catalog items, campaigns, and points ledgers</strong> from the platform?
          </p>
          <div className="rounded-md3-sm border border-error/30 bg-error-container/20 p-3 text-body-s text-on-surface">
            <span className="font-semibold text-error">Warning:</span> Platform admin accounts and reference tables will be preserved, but all business tenants and customer transactions will be permanently deleted. This action cannot be undone.
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="purge-all-reason" className="text-label-m text-on-surface font-medium">
              Reason for clearing all data (Required)
            </label>
            <textarea
              id="purge-all-reason"
              value={reason}
              disabled={pending}
              maxLength={MAX_REASON_LENGTH}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="w-full rounded-md3-xs border border-outline bg-surface p-2 text-body-m text-on-surface outline-none focus-visible:ring-2 focus-visible:ring-primary"
              placeholder="e.g. Resetting platform test data for production fresh start."
            />
          </div>

          {result !== null && !result.ok && (
            <p role="alert" className="text-body-s text-error">
              {result.message}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="text" size="sm" disabled={pending} onClick={handleClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="outlined"
              size="sm"
              disabled={pending || reasonInvalid}
              onClick={handleConfirm}
              className="border-error text-error bg-error/10 hover:bg-error/20"
            >
              {pending ? "Purging..." : "Confirm Purge All"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
