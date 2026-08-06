"use client";

import * as React from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PendingButton } from "@/components/ui/pending-button";
import { cn } from "@/lib/utils";

import type { RewardAffordability } from "../affordability";
import { claimReward } from "../actions";
import type { ClaimableRewardDTO } from "../types";
import { RewardShortfall } from "./reward-shortfall";

export interface RewardCardProps {
  reward: ClaimableRewardDTO;
  /**
   * Whether the caller can afford this reward right now, from
   * `groupRewardsByBusiness`/`affordability`. Omitted entirely renders the
   * reward as affordable - the page always passes this once wired; kept
   * optional so this component never crashes without a balance context.
   */
  affordability?: RewardAffordability | undefined;
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
export function RewardCard({ reward, affordability }: RewardCardProps) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [claimed, setClaimed] = React.useState(false);

  const outOfStock = reward.remaining !== null && reward.remaining <= 0;
  // Omitted entirely (no balance context wired) renders as affordable, same
  // as before this prop existed.
  const affordable = affordability?.affordable ?? true;

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
    // aria-disabled (not the native `disabled` attribute - this is a div, not
    // a control) so assistive tech does not read an unaffordable card as
    // "tappable" even though its Claim button below is the thing that is
    // actually inert. Doc 16's binding rule: grey via `on-surface-variant`,
    // never hide, and never grow a shadow (the `filled` variant has none).
    <Card variant="filled" className="flex flex-col gap-2 p-4" aria-disabled={!affordable}>
      <p className={cn("text-title-s", affordable ? "text-on-surface" : "text-on-surface-variant")}>
        {reward.name}
      </p>
      {/* The business name is a link to the shop's public page, not decoration.
          `/b/[slug]` had no consumer entry point anywhere in the app, and this
          is the natural one: someone reading "300 pts for a free latte" wants
          to know where, and what else is on offer there. The slug can be empty
          when the businesses read missed, in which case this stays plain text
          rather than linking to `/b/`. */}
      {reward.businessSlug ? (
        <Link
          href={`/b/${reward.businessSlug}`}
          className="w-fit text-body-s text-on-surface-variant underline-offset-4 hover:underline"
        >
          {reward.businessName}
        </Link>
      ) : (
        <p className="text-body-s text-on-surface-variant">{reward.businessName}</p>
      )}
      <Badge className={cn("w-fit", !affordable && "bg-surface-container-high text-on-surface-variant")}>
        {reward.pointsCost} pts
      </Badge>
      {reward.remaining !== null ? (
        <p className="text-label-s text-on-surface-variant">
          {outOfStock ? "None left" : `${reward.remaining} left`}
        </p>
      ) : null}
      {!affordable && affordability ? <RewardShortfall shortfall={affordability.shortfall} /> : null}
      {/* Spending points is a money path: the button must show it was tapped,
          refuse a second tap, and not resize while it does either. PendingButton
          handles all three -- it renders "Claim" and "Claiming" in the same grid
          cell, so the button is already as wide as the longer word at first
          paint and the card below it never moves.
          Unaffordable is folded into the same `disabled` the out-of-stock case
          already used: real `disabled`, not just a greyed style, so a tap can
          never reach `claimReward` and fail with POINTS_INSUFFICIENT. */}
      <PendingButton
        type="button"
        variant="tonal"
        size="touch"
        pending={pending}
        pendingLabel="Claiming"
        disabled={claimed || outOfStock || !affordable}
        onClick={handleClaim}
        className="mt-1 w-full"
      >
        {claimed ? "Claimed" : "Claim"}
      </PendingButton>
      {error ? (
        <p role="alert" className="text-label-s text-error">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
