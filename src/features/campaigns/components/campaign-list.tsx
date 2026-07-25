"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/consumer/empty-state";
import { cn } from "@/lib/utils";

import type { CampaignStatus } from "../types";
import type { CampaignRow } from "../server/types";

type ActionResult = { ok: true } | { ok: false; message: string };

export interface CampaignListProps {
  campaigns: CampaignRow[];
  onActivate: (campaignId: string) => Promise<ActionResult>;
  onPause: (campaignId: string) => Promise<ActionResult>;
  onResume: (campaignId: string) => Promise<ActionResult>;
  onEnd: (campaignId: string) => Promise<ActionResult>;
  onArchive: (campaignId: string) => Promise<ActionResult>;
}

const STATUS_ORDER: CampaignStatus[] = ["active", "scheduled", "draft", "paused", "ended", "archived"];

const STATUS_LABEL: Record<CampaignStatus, string> = {
  active: "Active",
  scheduled: "Scheduled",
  draft: "Draft",
  paused: "Paused",
  ended: "Ended",
  archived: "Archived",
};

const TYPE_LABEL: Record<string, string> = {
  promotion: "Promotion",
  discount: "Discount",
  seasonal: "Seasonal",
  holiday: "Holiday",
  event: "Event",
  reward: "Reward",
  loyalty: "Loyalty",
  membership: "Membership",
  birthday: "Birthday",
  referral: "Referral",
};

function statusChipClass(status: CampaignStatus): string {
  switch (status) {
    case "active":
      return "bg-secondary-container text-on-secondary-container";
    case "scheduled":
      return "border border-secondary text-secondary";
    case "paused":
      return "bg-surface-container-highest text-on-surface";
    case "ended":
      return "bg-surface-container-high text-on-surface-variant";
    case "archived":
      return "border border-outline-variant text-on-surface-variant";
    case "draft":
    default:
      return "bg-surface-container-high text-on-surface-variant";
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function scheduleSummary(campaign: CampaignRow): string {
  const starts = campaign.starts_at;
  const ends = campaign.ends_at;
  if (!starts && !ends) return "No schedule set";
  if (starts && ends) return `${formatDate(starts)} to ${formatDate(ends)}`;
  if (starts) return `Starts ${formatDate(starts)}`;
  return `Ends ${formatDate(ends as string)}`;
}

type ActionKind = "activate" | "pause" | "resume" | "end" | "archive";

// "end" is deliberately never grouped with the other actions here - it is
// one-way (no ended -> active edge, doc 34) so CampaignCard renders it
// behind its own confirm step rather than firing on a single click like
// pause/resume/archive do.
function actionsForStatus(status: CampaignStatus): { label: string; kind: ActionKind }[] {
  switch (status) {
    case "draft":
      return [
        { label: "Activate", kind: "activate" },
        { label: "Archive", kind: "archive" },
      ];
    case "scheduled":
      return [{ label: "Activate", kind: "activate" }];
    case "active":
      return [
        { label: "Pause", kind: "pause" },
        { label: "End", kind: "end" },
      ];
    case "paused":
      return [
        { label: "Resume", kind: "resume" },
        { label: "End", kind: "end" },
      ];
    case "ended":
      return [{ label: "Archive", kind: "archive" }];
    case "archived":
    default:
      return [];
  }
}

function CampaignCard({
  campaign,
  onActivate,
  onPause,
  onResume,
  onEnd,
  onArchive,
}: {
  campaign: CampaignRow;
  onActivate: (campaignId: string) => Promise<ActionResult>;
  onPause: (campaignId: string) => Promise<ActionResult>;
  onResume: (campaignId: string) => Promise<ActionResult>;
  onEnd: (campaignId: string) => Promise<ActionResult>;
  onArchive: (campaignId: string) => Promise<ActionResult>;
}) {
  const [pending, setPending] = React.useState(false);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [confirmingEnd, setConfirmingEnd] = React.useState(false);
  const status = campaign.status as CampaignStatus;

  async function run(kind: ActionKind) {
    setRowError(null);
    setPending(true);
    const handler = { activate: onActivate, pause: onPause, resume: onResume, end: onEnd, archive: onArchive }[
      kind
    ];
    const result = await handler(campaign.id);
    setPending(false);
    if (!result.ok) setRowError(result.message);
  }

  async function confirmEnd() {
    setConfirmingEnd(false);
    await run("end");
  }

  const actions = actionsForStatus(status);
  const clickableActions = actions.filter((action) => action.kind !== "end");
  const canEnd = actions.some((action) => action.kind === "end");

  return (
    <Card variant="outlined" className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-title-m text-on-surface">{campaign.name}</p>
        <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-label-m", statusChipClass(status))}>
          {STATUS_LABEL[status] ?? status}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-outline-variant px-2.5 py-0.5 text-label-m text-on-surface-variant">
          {TYPE_LABEL[campaign.type] ?? campaign.type}
        </span>
        <span className="text-body-s text-on-surface-variant">{scheduleSummary(campaign)}</span>
      </div>

      {campaign.description ? (
        <p className="text-body-s text-on-surface-variant">{campaign.description}</p>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-2">
        {clickableActions.map((action) => (
          <Button
            key={action.kind}
            type="button"
            variant={action.kind === "archive" ? "text" : "outlined"}
            size="sm"
            disabled={pending}
            onClick={() => run(action.kind)}
          >
            {action.label}
          </Button>
        ))}
        {canEnd && !confirmingEnd ? (
          <Button
            type="button"
            variant="text"
            size="sm"
            disabled={pending}
            onClick={() => setConfirmingEnd(true)}
          >
            End
          </Button>
        ) : null}
      </div>

      {canEnd && confirmingEnd ? (
        <div className="flex flex-col gap-2 rounded-md3-xs bg-error-container p-3">
          <p className="text-body-s text-on-error-container">
            Ending is permanent. You can duplicate the campaign to run it again.
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="filled" size="sm" disabled={pending} onClick={confirmEnd}>
              Confirm end
            </Button>
            <Button
              type="button"
              variant="text"
              size="sm"
              disabled={pending}
              onClick={() => setConfirmingEnd(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {rowError ? (
        <p role="alert" className="text-body-s text-error">
          {rowError}
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Renders campaigns grouped by status, in a fixed status order (active
 * first) so the most actionable campaigns surface first regardless of
 * insertion order. When the caller has already filtered `campaigns` down to
 * a single status (campaigns-manager's status-filter chips), only that
 * group's heading renders.
 */
export function CampaignList({
  campaigns,
  onActivate,
  onPause,
  onResume,
  onEnd,
  onArchive,
}: CampaignListProps) {
  if (campaigns.length === 0) {
    return (
      <EmptyState
        icon="campaign"
        title="No campaigns yet"
        body="Create a promotion, reward, or loyalty program to start engaging customers."
      />
    );
  }

  const grouped = STATUS_ORDER.map((status) => ({
    status,
    items: campaigns.filter((campaign) => campaign.status === status),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="flex flex-col gap-6">
      {grouped.map((group) => (
        <div key={group.status} className="flex flex-col gap-3">
          <h3 className="text-title-s text-on-surface-variant">
            {STATUS_LABEL[group.status]} ({group.items.length})
          </h3>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {group.items.map((campaign) => (
              <li key={campaign.id}>
                <CampaignCard
                  campaign={campaign}
                  onActivate={onActivate}
                  onPause={onPause}
                  onResume={onResume}
                  onEnd={onEnd}
                  onArchive={onArchive}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
