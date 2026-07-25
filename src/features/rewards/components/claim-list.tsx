import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/consumer/empty-state";
import { cn } from "@/lib/utils";

import type { MyClaimDTO } from "../types";

const STATUS_LABEL: Record<string, string> = {
  claimed: "Claimed",
  redeemed: "Redeemed",
  expired: "Expired",
  cancelled: "Cancelled",
};

// Status chips are neutral/informational, not reward figures - mango
// (tertiary) stays reserved for the points Badge per the design system's
// "mango only on points/reward figures" rule.
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

/** Y/M/D parts of `date` as observed in Asia/Manila, for calendar-day (not
 * raw-ms) comparisons. Mirrors src/lib/hours.ts's currentManilaWeekday
 * convention: "today"/"tomorrow" should reflect the business's timezone,
 * not the server or test runner's local zone. */
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

/**
 * Human expiry text for a 'claimed' reward: "Expired" once past, "Expires
 * today"/"Expires tomorrow" for the two near cases, otherwise "Expires in N
 * days". `now` defaults to the real current time and is only overridden by
 * tests.
 */
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

/**
 * The consumer's own reward claims: status chip, reward + business name,
 * points spent (Badge - reward figure, mango), an expiry countdown for
 * still-live 'claimed' rows, and a "Show QR" link to the redemption screen
 * for claims that are both status='claimed' AND not yet expired (a claimed-
 * but-expired row has simply aged out server-side into 'expired' via the
 * sweep job in most cases, but expiresAt is re-checked here too so a claim
 * that JUST passed its deadline never offers a QR that would 422 on mint).
 */
export function ClaimList({ claims, now = new Date() }: ClaimListProps) {
  if (claims.length === 0) {
    return (
      <EmptyState
        icon="redeem"
        title="Nothing claimed yet"
        body="Rewards you claim will appear here with their QR codes."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {claims.map((claim) => {
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
                <p className="text-label-m text-on-surface-variant">{formatExpiry(claim.expiresAt, now)}</p>
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
          </Card>
        );
      })}
    </div>
  );
}
