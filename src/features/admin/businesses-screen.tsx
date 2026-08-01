import { EmptyState } from "@/components/consumer/empty-state";
import { cn } from "@/lib/utils";

import { BusinessDecisionPanel } from "./business-decision-panel";
import { queueAge, slaChipClass } from "./presenter";
import type { AdminBusinessReviewItem } from "./types";

// ===========================================================================
// `/admin/businesses` - the merchant verification queue (doc 31 section 3).
//
// A SYNCHRONOUS, PROP-DRIVEN server component with one client island per row
// (the decision panel, which is a client component only because a reason has to
// be typed before anything can be submitted).
//
// ---------------------------------------------------------------------------
// WHY EACH ROW IS A CARD AND NOT A LINE IN A TABLE.
// ---------------------------------------------------------------------------
// The fraud queue is a triage list: an admin scans it, picks the worst item and
// opens it. This is not a triage list. There is no detail screen behind these
// rows, because the decision needs six facts and a reason, and six facts fit on
// a card. Adding a detail route would put a click between an applicant and the
// only decision that unblocks them, for no information gained.
//
// NULL IS NOT EMPTY, the same rule the rest of this portal follows. An empty
// queue is a claim that nobody is waiting to trade, and a failed read is not
// entitled to make it.
//
// TOKENS ONLY. Tertiary (Mango) is absent: it is rewards language and nothing
// here is a reward.
// ===========================================================================

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-label-s text-on-surface-variant">{label}</p>
      <p className="truncate text-body-m text-on-surface">{value}</p>
    </div>
  );
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
  // Aged from the SUBMISSION, not from registration: a merchant who registered
  // in March and applied yesterday has been waiting one day, and dating the
  // wait from signup would put them at the top of a queue ordered by urgency
  // they have no claim to. `createdAt` is still shown as a separate fact,
  // because "registered long before applying" is worth an admin's attention.
  //
  // `queueAge` and its SLA thresholds are the receipt queue's, reused rather
  // than forked. The numbers were chosen for receipts (24h target, 48h alert)
  // and they happen to be defensible here too, but the reuse is about the
  // vocabulary: an admin reading "Waiting 3 days" in an amber chip should mean
  // the same thing on every queue in this portal.
  const age = queueAge(item.submittedAt ?? item.createdAt, now);

  return (
    <li
      className={cn(
        "flex flex-col gap-4 rounded-md3-md border border-outline-variant bg-surface p-4",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-title-m text-on-surface">{item.name}</h2>
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

      {/*
        The earning rule gets its own row rather than a fourth cell, because it
        is the only fact here that DECIDES anything: `activate_business` (0033)
        refuses the approval without it.
      */}
      <div
        className={cn(
          "rounded-md3-sm p-3",
          item.earningRule === null
            ? "bg-error-container text-on-error-container"
            : "bg-surface-container text-on-surface",
        )}
      >
        <p className="text-label-s">How their customers earn</p>
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
  now: Date;
  /** doc 01's matrix: `support` is read-only everywhere and never mutates. */
  canAct: boolean;
  /** The queue could not be read. "Nobody waiting" would be a lie. */
  unavailable?: boolean;
}

export function AdminBusinessesScreen({
  items,
  now,
  canAct,
  unavailable = false,
}: AdminBusinessesScreenProps) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-headline-s text-on-surface">Businesses awaiting review</h1>
        <p className="text-body-s text-on-surface-variant">
          Nobody on this list can be found by a customer, scanned for, or earn
          anyone a point. Approving is what changes that.
        </p>
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
          title="No business is waiting on a decision"
          body="Merchants land here when their owner sends them for review from their dashboard. An empty list means nobody has asked, not that nobody has signed up."
          className="border border-outline-variant bg-surface"
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
