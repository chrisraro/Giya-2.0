"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/consumer/empty-state";
import { cn } from "@/lib/utils";

import type { RewardCatalogItem } from "../types";

type ActionResult = { ok: true } | { ok: false; message: string };

export interface RewardListProps {
  rewards: RewardCatalogItem[];
  onEdit: (reward: RewardCatalogItem) => void;
  onSetActive: (rewardId: string, isActive: boolean) => Promise<ActionResult>;
  emptyBody: string;
}

/** Doc 32 section 9.3: "remaining displayed with low-stock badge <= 10%". */
const LOW_STOCK_FRACTION = 0.1;

export type StockState = "unlimited" | "out" | "low" | "ok";

export function stockState(reward: Pick<RewardCatalogItem, "totalInventory" | "remaining">): StockState {
  if (reward.totalInventory === null) return "unlimited";
  const remaining = reward.remaining ?? reward.totalInventory;
  if (remaining <= 0) return "out";
  if (remaining <= Math.floor(reward.totalInventory * LOW_STOCK_FRACTION)) return "low";
  return "ok";
}

export function stockLabel(reward: Pick<RewardCatalogItem, "totalInventory" | "remaining">): string {
  if (reward.totalInventory === null) return "Unlimited stock";
  const remaining = reward.remaining ?? reward.totalInventory;
  if (remaining <= 0) return "Out of stock";
  return `${remaining} of ${reward.totalInventory} left`;
}

function stockChipClass(state: StockState): string {
  switch (state) {
    case "out":
      return "bg-error-container text-on-error-container";
    case "low":
      return "border border-error text-error";
    default:
      return "border border-outline-variant text-on-surface-variant";
  }
}

function RewardCard({
  reward,
  onEdit,
  onSetActive,
}: {
  reward: RewardCatalogItem;
  onEdit: (reward: RewardCatalogItem) => void;
  onSetActive: (rewardId: string, isActive: boolean) => Promise<ActionResult>;
}) {
  const [pending, setPending] = React.useState(false);
  const [rowError, setRowError] = React.useState<string | null>(null);

  const state = stockState(reward);
  const campaign = reward.campaign;

  async function toggleActive() {
    setRowError(null);
    setPending(true);
    const result = await onSetActive(reward.id, !reward.isActive);
    setPending(false);
    if (!result.ok) setRowError(result.message);
  }

  return (
    <Card variant="outlined" className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-title-m text-on-surface">{reward.name}</p>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-0.5 text-label-m",
            reward.isActive
              ? "bg-secondary-container text-on-secondary-container"
              : "bg-surface-container-high text-on-surface-variant",
          )}
        >
          {reward.isActive ? "Active" : "Off"}
        </span>
      </div>

      {/* Mango (tertiary) is reserved for points and reward language; the
          points price is exactly that, so Badge is used verbatim here. */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{reward.pointsCost === 0 ? "Free claim" : `${reward.pointsCost} pts`}</Badge>
        <span
          className={cn("rounded-full px-2.5 py-0.5 text-label-m", stockChipClass(state))}
        >
          {stockLabel(reward)}
        </span>
      </div>

      {reward.description ? (
        <p className="text-body-s text-on-surface-variant">{reward.description}</p>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-body-s">
        <dt className="text-on-surface-variant">Per customer</dt>
        <dd className="text-on-surface">{reward.perCustomerLimit}</dd>
        <dt className="text-on-surface-variant">Claim expires</dt>
        <dd className="text-on-surface">{reward.claimExpiryDays} days</dd>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-outline-variant px-2.5 py-0.5 text-label-m text-on-surface-variant">
          {campaign?.name ?? "Campaign unavailable"}
        </span>
        {campaign && !campaign.claimable ? (
          <span className="text-body-s text-on-surface-variant">
            {campaign.terminal ? "Campaign finished" : "Campaign not live yet"}
          </span>
        ) : null}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2">
        <Button type="button" variant="outlined" size="sm" onClick={() => onEdit(reward)}>
          Edit
        </Button>
        <Button
          type="button"
          variant="text"
          size="sm"
          disabled={pending}
          onClick={toggleActive}
        >
          {reward.isActive ? "Turn off" : "Turn on"}
        </Button>
      </div>

      {rowError ? (
        <p role="alert" className="text-body-s text-error">
          {rowError}
        </p>
      ) : null}
    </Card>
  );
}

export function RewardList({ rewards, onEdit, onSetActive, emptyBody }: RewardListProps) {
  if (rewards.length === 0) {
    return <EmptyState icon="redeem" title="No rewards yet" body={emptyBody} />;
  }

  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {rewards.map((reward) => (
        <li key={reward.id}>
          <RewardCard reward={reward} onEdit={onEdit} onSetActive={onSetActive} />
        </li>
      ))}
    </ul>
  );
}
