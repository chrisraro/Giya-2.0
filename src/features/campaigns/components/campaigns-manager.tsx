"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";

import {
  activateCampaign,
  archiveCampaign,
  createLoyaltyCampaign,
  createPromotionCampaign,
  createRewardCampaign,
  pauseCampaign,
  resumeCampaign,
  upsertBaseRule,
} from "../actions";
import { CampaignForm, type CampaignFormOutput } from "./campaign-form";
import { CampaignList } from "./campaign-list";
import { EarningRuleCard } from "./earning-rule-card";
import type { BaseRuleInput } from "../schemas";
import type { CampaignStatus } from "../types";
import type { CampaignRow, PointsRuleRow } from "../server/types";

type ActionResult = { ok: true } | { ok: false; message: string };

export interface CampaignsManagerBusiness {
  id: string;
  name: string;
}

export interface CampaignsManagerProps {
  business: CampaignsManagerBusiness;
  campaigns: CampaignRow[];
  baseRule: PointsRuleRow | null;
}

const STATUS_FILTERS: { value: CampaignStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "scheduled", label: "Scheduled" },
  { value: "draft", label: "Draft" },
  { value: "paused", label: "Paused" },
  { value: "ended", label: "Ended" },
  { value: "archived", label: "Archived" },
];

/**
 * Business-portal campaign and earning-rule management screen. Owns the
 * create-campaign dialog state and the status-filter chip selection;
 * campaigns/baseRule themselves are read straight from props (server
 * actions call revalidatePath("/business/campaigns"), so a successful
 * mutation refreshes this page's data rather than being mirrored into local
 * state - same convention as src/features/menu/components/menu-manager.tsx).
 */
export function CampaignsManager({ business, campaigns, baseRule }: CampaignsManagerProps) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [formSubmitting, setFormSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<CampaignStatus | "all">("all");

  const filteredCampaigns =
    statusFilter === "all" ? campaigns : campaigns.filter((campaign) => campaign.status === statusFilter);

  function openDialog() {
    setFormError(null);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setFormError(null);
  }

  async function handleSubmitCampaign(output: CampaignFormOutput) {
    setFormSubmitting(true);
    setFormError(null);

    const result =
      output.type === "promotion"
        ? await createPromotionCampaign(output.data)
        : output.type === "reward"
          ? await createRewardCampaign(output.data)
          : await createLoyaltyCampaign(output.data);

    setFormSubmitting(false);
    if (!result.ok) {
      setFormError(result.message);
      return;
    }
    closeDialog();
  }

  async function handleActivate(campaignId: string): Promise<ActionResult> {
    const result = await activateCampaign({ campaignId });
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }

  async function handlePause(campaignId: string): Promise<ActionResult> {
    const result = await pauseCampaign({ campaignId });
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }

  async function handleResume(campaignId: string): Promise<ActionResult> {
    const result = await resumeCampaign({ campaignId });
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }

  async function handleArchive(campaignId: string): Promise<ActionResult> {
    const result = await archiveCampaign({ campaignId });
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }

  async function handleSaveBaseRule(input: BaseRuleInput): Promise<ActionResult> {
    const result = await upsertBaseRule(input);
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-headline-s text-on-surface">Campaigns</h1>
          <p className="text-body-s text-on-surface-variant">
            Promotions, rewards, and loyalty programs for {business.name}
          </p>
        </div>
        <Button type="button" variant="filled" size="md" onClick={openDialog}>
          New campaign
        </Button>
      </div>

      <EarningRuleCard baseRule={baseRule} onSave={handleSaveBaseRule} />

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

      <CampaignList
        campaigns={filteredCampaigns}
        onActivate={handleActivate}
        onPause={handlePause}
        onResume={handleResume}
        onArchive={handleArchive}
      />

      <Dialog open={dialogOpen} onClose={closeDialog} title="New campaign">
        <CampaignForm
          onSubmit={handleSubmitCampaign}
          onCancel={closeDialog}
          submitting={formSubmitting}
          serverError={formError}
        />
      </Dialog>
    </div>
  );
}
