"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";

import { createReward, setRewardActive, updateReward } from "../actions";
import { RewardForm, type RewardFormOutput } from "./reward-form";
import { RewardList } from "./reward-list";
import type { CampaignOption, RewardCatalogItem } from "../types";

type ActionResult = { ok: true } | { ok: false; message: string };

export interface RewardsManagerProps {
  businessName: string;
  rewards: RewardCatalogItem[];
  /** Campaigns a new reward may be parented to (the non-terminal ones). */
  availableCampaigns: CampaignOption[];
}

type StatusFilter = "all" | "active" | "inactive";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Turned off" },
];

/**
 * Business-portal reward catalog. Owns the create/edit dialog state and the
 * status filter; `rewards` itself is read straight from props, because the
 * server actions call revalidatePath("/business/rewards") and a successful
 * mutation refreshes this page's data - the same convention as
 * src/features/campaigns/components/campaigns-manager.tsx.
 */
export function RewardsManager({ businessName, rewards, availableCampaigns }: RewardsManagerProps) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<RewardCatalogItem | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");

  const canCreate = availableCampaigns.length > 0;

  const filtered = rewards.filter((reward) => {
    if (statusFilter === "active") return reward.isActive;
    if (statusFilter === "inactive") return !reward.isActive;
    return true;
  });

  function openCreate() {
    setEditing(null);
    setFormError(null);
    setDialogOpen(true);
  }

  function openEdit(reward: RewardCatalogItem) {
    setEditing(reward);
    setFormError(null);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditing(null);
    setFormError(null);
  }

  async function handleSubmit(output: RewardFormOutput) {
    setSubmitting(true);
    setFormError(null);

    const result = editing
      ? await updateReward({
          rewardId: editing.id,
          name: output.name,
          ...(output.description ? { description: output.description } : {}),
          pointsCost: output.pointsCost,
          totalInventory: output.totalInventory ?? null,
          perCustomerLimit: output.perCustomerLimit,
          claimExpiryDays: output.claimExpiryDays,
          ...(output.terms ? { terms: output.terms } : {}),
        })
      : await createReward({
          campaignId: output.campaignId,
          name: output.name,
          ...(output.description ? { description: output.description } : {}),
          pointsCost: output.pointsCost,
          totalInventory: output.totalInventory ?? null,
          perCustomerLimit: output.perCustomerLimit,
          claimExpiryDays: output.claimExpiryDays,
          ...(output.terms ? { terms: output.terms } : {}),
        });

    setSubmitting(false);
    if (!result.ok) {
      setFormError(result.message);
      return;
    }
    closeDialog();
  }

  async function handleSetActive(rewardId: string, isActive: boolean): Promise<ActionResult> {
    const result = await setRewardActive({ rewardId, isActive });
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-headline-s text-on-surface">Rewards</h1>
          <p className="text-body-s text-on-surface-variant">
            What customers of {businessName} can claim with their points
          </p>
        </div>
        <Button
          type="button"
          variant="filled"
          size="md"
          onClick={openCreate}
          disabled={!canCreate}
        >
          New reward
        </Button>
      </div>

      {canCreate ? null : (
        <Card variant="outlined" className="flex flex-col gap-1 p-4">
          <p className="text-title-s text-on-surface">Start a campaign first</p>
          <p className="text-body-s text-on-surface-variant">
            Every reward belongs to a campaign, and only a campaign that is still running can hand
            rewards out. Create one on the Campaigns page, then come back here.
          </p>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((filter) => (
          <Chip
            key={filter.value}
            label={filter.label}
            selected={statusFilter === filter.value}
            onClick={() => setStatusFilter(filter.value)}
          />
        ))}
      </div>

      <RewardList
        rewards={filtered}
        onEdit={openEdit}
        onSetActive={handleSetActive}
        emptyBody={
          canCreate
            ? "Add something customers can spend their points on: a free drink, a discount, a birthday treat."
            : "Rewards live inside campaigns. Create a campaign first, then add what customers can claim."
        }
      />

      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        title={editing ? "Edit reward" : "New reward"}
      >
        <RewardForm
          campaigns={availableCampaigns}
          reward={editing}
          onSubmit={handleSubmit}
          onCancel={closeDialog}
          submitting={submitting}
          serverError={formError}
        />
      </Dialog>
    </div>
  );
}
