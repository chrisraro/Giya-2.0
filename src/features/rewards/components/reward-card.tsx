"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

import { claimReward } from "../actions";
import type { ClaimableRewardDTO } from "../types";

export interface RewardCardProps {
  reward: ClaimableRewardDTO;
}

/**
 * One claimable reward: name, business, points cost (Badge - reward figure,
 * mango), a "remaining" hint when stock is tracked, and a Claim button that
 * calls the claimReward server action directly (this IS the "small client
 * component calling the claimReward action" the task-5 brief asks for - no
 * wrapper needed, since claimReward is already a "use server" action and can
 * be imported straight into a client component).
 *
 * On {ok:false} the action's own consumer-friendly message (see
 * server/service.ts's CLAIM_ERROR_COPY) is shown inline. On success,
 * claimReward's revalidatePath("/rewards") + revalidatePath("/wallet")
 * refresh the server-rendered lists on this page; this component only needs
 * to reflect the immediate result of ITS OWN click (pending -> claimed or
 * pending -> error), not resync with the refreshed list itself.
 */
export function RewardCard({ reward }: RewardCardProps) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [claimed, setClaimed] = React.useState(false);

  const outOfStock = reward.remaining !== null && reward.remaining <= 0;

  async function handleClaim() {
    setPending(true);
    setError(null);
    const result = await claimReward({ rewardId: reward.rewardId });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setClaimed(true);
  }

  return (
    <Card variant="filled" className="flex flex-col gap-2 p-4">
      <p className="text-title-s text-on-surface">{reward.name}</p>
      <p className="text-body-s text-on-surface-variant">{reward.businessName}</p>
      <Badge className="w-fit">{reward.pointsCost} pts</Badge>
      {reward.remaining !== null ? (
        <p className="text-label-s text-on-surface-variant">
          {outOfStock ? "None left" : `${reward.remaining} left`}
        </p>
      ) : null}
      <Button
        type="button"
        variant="tonal"
        size="touch"
        disabled={pending || claimed || outOfStock}
        onClick={handleClaim}
        className="mt-1 w-full"
      >
        {claimed ? "Claimed" : pending ? "Claiming..." : "Claim"}
      </Button>
      {error ? (
        <p role="alert" className="text-label-s text-error">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
