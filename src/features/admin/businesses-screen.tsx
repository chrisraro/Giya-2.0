import Link from "next/link";
import { EmptyState } from "@/components/consumer/empty-state";
import { cn } from "@/lib/utils";

import { BusinessDecisionPanel } from "./business-decision-panel";
import { queueAge, slaChipClass } from "./presenter";
import type { AdminBusinessReviewItem } from "./types";

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-label-s text-on-surface-variant">{label}</p>
      <p className="truncate text-body-m text-on-surface">{value}</p>
    </div>
  );
}

function statusChipClass(status: string): string {
  switch (status) {
    case "active":
      return "bg-emerald-500/10 text-emerald-600 border border-emerald-500/30";
    case "pending":
    case "pending_verification":
      return "bg-amber-500/10 text-amber-600 border border-amber-500/30";
    case "suspended":
      return "bg-error-container text-on-error-container";
    default:
      return "bg-surface-container text-on-surface-variant";
  }
}

function BusinessCard({
  item,
  now,
  canAct,
}: {
  item: AdminBusinessReviewItem;
  now: Date;
  canAct: boolean;
}) {
  const age = queueAge(item.submittedAt ?? item.createdAt, now);

  return (
    <li
      className={cn(
        "flex flex-col gap-4 rounded-md3-md border border-outline-variant bg-surface-container-lowest p-5 shadow-xs",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-title-m font-semibold text-on-surface">{item.name}</h2>
            <span className={cn("rounded-full px-2.5 py-0.5 text-label-s font-medium capitalize", statusChipClass(item.status))}>
              {item.status.replace("_", " ")}
            </span>
          </div>
          <p className="truncate text-body-s text-on-surface-variant">
            {item.businessTypeName ?? "Type not set"}
            {item.cityName === null ? "" : ` · ${item.cityName}`}
            {` · giya.ph/b/${item.slug}`}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-label-m",
            slaChipClass(age.state),
          )}
        >
          {age.label}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Owner" value={item.ownerName ?? "Not read"} />
        <Fact
          label="Contact"
          value={item.contactEmail ?? item.contactPhone ?? "None given"}
        />
        <Fact label="Registered" value={item.createdAt.slice(0, 10)} />
        <Fact
          label="Menu"
          value={item.hasMenu ? "Has items" : "Nothing on it yet"}
        />
      </div>

      <div
        className={cn(
          "rounded-md3-sm p-3",
          item.earningRule === null
            ? "bg-error-container text-on-error-container"
            : "bg-surface-container text-on-surface",
        )}
      >
        <p className="text-label-s font-medium">How their customers earn</p>
        <p className="text-body-m">
          {item.earningRule ?? "No earning rule set. Giya will refuse this activation."}
        </p>
      </div>

      {item.applicantNote !== null && (
        <div className="rounded-md3-sm border border-outline-variant p-3">
          <p className="text-label-s text-on-surface-variant">What they told us</p>
          <p className="text-body-m text-on-surface">{item.applicantNote}</p>
        </div>
      )}

      <BusinessDecisionPanel
        businessId={item.businessId}
        businessName={item.name}
        canAct={canAct}
        earningRule={item.earningRule}
      />
    </li>
  );
}

export interface AdminBusinessesScreenProps {
  items: readonly AdminBusinessReviewItem[];
  filter?: "pending" | "active" | "all";
  now: Date;
  canAct: boolean;
  unavailable?: boolean;
}

export function AdminBusinessesScreen({
  items,
  filter = "pending",
  now,
  canAct,
  unavailable = false,
}: AdminBusinessesScreenProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-headline-s font-bold text-on-surface">Merchant Directory & Verification</h1>
          <p className="text-body-s text-on-surface-variant">
            Review registered business applications, activate accounts, and audit merchant statuses.
          </p>
        </div>

        {/* Filter Tabs */}
        <div className="flex items-center gap-1 rounded-full border border-outline-variant bg-surface-container-low p-1">
          <Link
            href="/admin/businesses?filter=pending"
            className={cn(
              "rounded-full px-3.5 py-1 text-label-m font-medium transition-colors",
              filter === "pending"
                ? "bg-primary text-on-primary shadow-xs"
                : "text-on-surface-variant hover:text-on-surface",
            )}
          >
            Pending Review
          </Link>
          <Link
            href="/admin/businesses?filter=active"
            className={cn(
              "rounded-full px-3.5 py-1 text-label-m font-medium transition-colors",
              filter === "active"
                ? "bg-primary text-on-primary shadow-xs"
                : "text-on-surface-variant hover:text-on-surface",
            )}
          >
            Active
          </Link>
          <Link
            href="/admin/businesses?filter=all"
            className={cn(
              "rounded-full px-3.5 py-1 text-label-m font-medium transition-colors",
              filter === "all"
                ? "bg-primary text-on-primary shadow-xs"
                : "text-on-surface-variant hover:text-on-surface",
            )}
          >
            All
          </Link>
        </div>
      </div>

      {unavailable ? (
        <div
          role="alert"
          className="rounded-md3-md border border-outline bg-surface-container p-4 text-body-m text-on-surface"
        >
          This queue cannot be loaded right now, so nothing below is complete. Do
          not read an empty list as nobody waiting. Try again shortly.
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon="storefront"
          title={
            filter === "active"
              ? "No active businesses found"
              : filter === "all"
              ? "No registered businesses found"
              : "No business is waiting on a decision"
          }
          body={
            filter === "pending"
              ? "Merchants land here when they register or submit for review. An empty list means no merchants are currently pending review."
              : "No business accounts match the current filter selection."
          }
          className="border border-outline-variant bg-surface-container-lowest"
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map((item) => (
            <BusinessCard key={item.businessId} item={item} now={now} canAct={canAct} />
          ))}
        </ul>
      )}
    </div>
  );
}
