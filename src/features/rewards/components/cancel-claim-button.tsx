"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { PendingButton } from "@/components/ui/pending-button";

import { cancelClaim } from "../actions";

export interface CancelClaimButtonProps {
  claimId: string;
  /** reward_claims.points_spent for this claim - 0 for a free/loyalty-
   *  completion claim, which gets non-punitive copy with no points mention. */
  pointsSpent: number;
  className?: string;
}

/**
 * The consumer-facing cancel affordance for an unredeemed claim
 * (supabase/migrations/0050_cancel_claim.sql): a trigger button plus a
 * Dialog confirm step, mirroring src/features/receipts/review/
 * decision-screen.tsx's confirm idiom so a mis-tap never fires the RPC
 * directly.
 *
 * Cancelling is destructive of the CLAIM, not of the consumer's points -
 * doc 03 Key Finding 1 names "points debited on intent and never returned"
 * as the top complaint driver this task exists to fix, so the copy says the
 * points come back immediately rather than warning the consumer away from
 * tapping the button. Callers decide WHEN to render this component at all
 * (only for status === 'claimed' claims - see ClaimList and RedemptionQr);
 * it does not re-check status itself.
 */
export function CancelClaimButton({ claimId, pointsSpent, className }: CancelClaimButtonProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    const result = await cancelClaim({ claimId });
    setPending(false);

    if (result.ok) {
      setOpen(false);
      router.refresh();
      return;
    }
    setError(result.message);
  }

  return (
    <>
      <Button
        type="button"
        variant="text"
        size="sm"
        className={className}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Cancel claim
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Cancel this claim?"
        describedById="cancel-claim-confirm-body"
      >
        <p id="cancel-claim-confirm-body" className="text-body-m text-on-surface-variant">
          {pointsSpent > 0
            ? `Cancel this claim and get your ${pointsSpent} points back. This does not affect the reward itself - you can claim it again later.`
            : "Cancel this claim? You can claim this reward again later."}
        </p>

        {error !== null && (
          <p role="alert" className="text-body-m text-error">
            {error}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="text" size="md" onClick={() => setOpen(false)}>
            Keep claim
          </Button>
          <PendingButton
            type="button"
            variant="filled"
            size="md"
            pending={pending}
            pendingLabel="Cancelling"
            onClick={() => void submit()}
          >
            Yes, cancel
          </PendingButton>
        </div>
      </Dialog>
    </>
  );
}
