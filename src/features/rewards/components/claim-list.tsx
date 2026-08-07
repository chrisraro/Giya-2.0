"use client";

import { useState } from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/consumer/empty-state";
import { cn } from "@/lib/utils";

import { CancelClaimButton } from "./cancel-claim-button";
import type { MyClaimDTO } from "../types";

const STATUS_LABEL: Record<string, string> = {
  claimed: "Claimed",
  redeemed: "Redeemed",
  expired: "Expired",
  cancelled: "Cancelled",
};

function statusChipClass(status: string): string {
  switch (status) {
    case "claimed":
      return "bg-secondary-container text-on-secondary-container";
    case "redeemed":
      return "bg-surface-container-highest text-on-surface";
    case "expired":
    case "cancelled":
    default:
      return "border border-outline-variant text-on-surface-variant";
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function manilaDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function formatExpiry(expiresAtIso: string, now: Date = new Date()): string {
  const expiresAt = new Date(expiresAtIso);
  if (expiresAt.getTime() <= now.getTime()) return "Expired";

  const nowParts = manilaDateParts(now);
  const expiryParts = manilaDateParts(expiresAt);
  const nowUtc = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
  const expiryUtc = Date.UTC(expiryParts.year, expiryParts.month - 1, expiryParts.day);
  const dayDiff = Math.round((expiryUtc - nowUtc) / DAY_MS);

  if (dayDiff <= 0) return "Expires today";
  if (dayDiff === 1) return "Expires tomorrow";
  return `Expires in ${dayDiff} days`;
}

export interface ClaimListProps {
  claims: MyClaimDTO[];
  /** Overridable for tests; defaults to the real current time. */
  now?: Date;
}

type TabType = "all" | "claimed" | "redeemed" | "expired" | "cancelled";

export function ClaimList({ claims, now = new Date() }: ClaimListProps) {
  const [activeTab, setActiveTab] = useState<TabType>("all");

  const filteredClaims = claims.filter((claim) => {
    if (activeTab === "all") return true;
    return claim.status === activeTab;
  });

  if (claims.length === 0) {
    return (
      <EmptyState
        icon="redeem"
        title="Nothing claimed yet"
        body="Rewards you claim will appear here with their QR codes."
      />
    );
  }

  const tabs: { id: TabType; label: string }[] = [
    { id: "all", label: "All" },
    { id: "claimed", label: "Active" },
    { id: "redeemed", label: "Redeemed" },
    { id: "expired", label: "Expired" },
    { id: "cancelled", label: "Cancelled" },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Filter Tabs */}
      <div className="flex gap-1 overflow-x-auto pb-1 no-scrollbar">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "rounded-full px-3.5 py-1 text-label-s transition-colors shrink-0",
              activeTab === tab.id
                ? "bg-primary text-on-primary font-medium"
                : "bg-surface-container text-on-surface-variant hover:bg-surface-container-high"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {filteredClaims.length === 0 ? (
        <p className="py-4 text-center text-body-s text-on-surface-variant">
          No {activeTab === "all" ? "" : activeTab} claims found.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {filteredClaims.map((claim) => {
            const showQr = claim.status === "claimed" && new Date(claim.expiresAt) > now;

            return (
              <Card key={claim.claimId} variant="outlined" className="flex flex-col gap-2 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-title-s text-on-surface">{claim.rewardName}</p>
                    <p className="text-body-s text-on-surface-variant">{claim.businessName}</p>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2.5 py-0.5 text-label-m",
                      statusChipClass(claim.status),
                    )}
                  >
                    {STATUS_LABEL[claim.status] ?? claim.status}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <Badge>{claim.pointsSpent} pts</Badge>
                  {claim.status === "claimed" ? (
                    <p className="text-label-m text-on-surface-variant">
                      {formatExpiry(claim.expiresAt, now)}
                    </p>
                  ) : null}
                </div>

                {showQr ? (
                  <Link
                    href={`/rewards/claims/${claim.claimId}`}
                    className="mt-1 flex h-12 items-center justify-center rounded-full bg-primary text-label-l text-on-primary transition-colors duration-200 ease-standard hover:opacity-90"
                  >
                    Show QR
                  </Link>
                ) : null}

                {claim.status === "claimed" ? (
                  <CancelClaimButton
                    claimId={claim.claimId}
                    pointsSpent={claim.pointsSpent}
                    className="self-start"
                  />
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
