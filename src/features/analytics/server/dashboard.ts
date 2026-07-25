import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

import { manilaDayOf, manilaDaySeries, manilaDayWindow } from "../manila-day";
import {
  countVisits,
  entriesWithin,
  formatCount,
  formatPoints,
  periodDelta,
  relativeTime,
  sumPoints,
  visitsByDay,
  visitsChartLabel,
  type LedgerEntry,
} from "../metrics";
import type { ActivityItem, BusinessDashboard, DashboardKpi, KpiDelta } from "../types";

// ===========================================================================
// THE BUSINESS DASHBOARD'S ONLY DATA SOURCE.
//
// ------------------------------ TENANCY ------------------------------------
// `businessId` ALWAYS arrives as an argument and its only legitimate source is
// `resolveOwnerBusiness()` (src/features/businesses/server/resolve-owner-
// business.ts), which reads the caller's first ACTIVE `business_staff` row
// under the caller's own session. It is never taken from a URL segment, a
// query parameter, a form field or a JWT claim.
//
// Every query below runs on the SESSION-SCOPED client, so RLS is the real
// fence and the explicit `.eq("business_id", businessId)` is defence in depth
// (the same posture as src/features/campaigns/server/repo.ts). The one
// exception is the display-name lookup at the bottom, which is annotated where
// it lives.
//
// ------------------------------ ROLE ---------------------------------------
// Doc 32 section 12 grants the dashboard to owner, manager and marketing, and
// the RLS policies on the three tables read here (`points_transactions`,
// `business_customers`, `redemptions`) are that same set or wider. No role
// check is repeated in this file: the policies already are the check, and a
// second one in TypeScript would be a second place for it to drift.
//
// `receipts` is deliberately NOT read here even though doc 40 makes it the
// reporting truth for visits: 0017's `receipts_staff_select` is owner and
// manager only, so a marketing member (who doc 32 grants this screen to) would
// silently see zero visits. The earn ledger is the source that all three roles
// can read, and the honest consequence is recorded on `countVisits` below.
// ===========================================================================

/**
 * How many Manila days each KPI window covers, and therefore how wide the
 * chart is. Rolling, not calendar: see `periodDelta` for why.
 */
const WINDOW_DAYS = 7;

/**
 * Ceiling on the ledger read, so one very busy tenant cannot turn a dashboard
 * render into an unbounded transfer.
 *
 * The read asks for an EXACT count alongside the rows, so truncation is
 * detected by comparing the two rather than by testing `rows.length` against
 * this constant. PostgREST can impose its own `max-rows` below this number,
 * and a cap that silently reports a truncated sum as a total is exactly the
 * class of quiet lie this whole change exists to remove.
 */
const LEDGER_ROW_CAP = 5_000;

/** Rows pulled from each activity source before the two are merged and sliced. */
const ACTIVITY_SOURCE_LIMIT = 12;

/** Rows shown in the feed. */
const ACTIVITY_LIMIT = 8;

interface LedgerRow {
  consumer_id: string;
  points: number;
  created_at: string;
}

interface RecentEarnRow extends LedgerRow {
  id: string;
}

interface RedeemedClaimRow {
  id: string;
  consumer_id: string;
  reward_id: string;
  redeemed_at: string | null;
}

/**
 * Everything the dashboard renders, or null when it could not be read.
 *
 * Null is the only failure shape, and it is deliberately coarse. An empty
 * result set is not a failure: a brand new merchant legitimately has zero of
 * everything, and this loader returns those zeros. Null means a read ERRORED,
 * and a dashboard that cannot prove a number is zero must not print a zero.
 */
export async function loadBusinessDashboard(
  businessId: string,
  now: Date = new Date(),
): Promise<BusinessDashboard | null> {
  const today = manilaDayOf(now);

  // Two adjacent rolling windows: the current 7 Manila days (today included,
  // and therefore partial) and the 7 immediately before it. One fetch spans
  // both so the comparison cannot be assembled from two differently filtered
  // reads.
  const allDays = manilaDaySeries(today, WINDOW_DAYS * 2);
  const previousDays = allDays.slice(0, WINDOW_DAYS);
  const currentDays = allDays.slice(WINDOW_DAYS);

  const fullWindow = manilaDayWindow(allDays);
  const currentWindow = manilaDayWindow(currentDays);
  const previousWindow = manilaDayWindow(previousDays);

  const supabase = await createClient();

  const [ledger, redemptionsNow, redemptionsBefore, customers, newCustomers, recentEarns, recentClaims] =
    await Promise.all([
      // Doc 40: points issued = sum(points) where type='earn'; visits are the
      // distinct (consumer, manila day) pairs over the same rows.
      supabase
        .from("points_transactions")
        .select("consumer_id, points, created_at", { count: "exact" })
        .eq("business_id", businessId)
        .eq("type", "earn")
        .gte("created_at", fullWindow.startIso)
        .lt("created_at", fullWindow.endIso)
        .order("created_at", { ascending: true })
        .limit(LEDGER_ROW_CAP),

      countRedemptions(supabase, businessId, currentWindow),
      countRedemptions(supabase, businessId, previousWindow),

      supabase
        .from("business_customers")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId),

      // Doc 40 "New customer (for business B, day D)": first_visit_at falls on
      // Manila day D. Counted over the current window rather than derived from
      // any parallel counter.
      supabase
        .from("business_customers")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .gte("first_visit_at", currentWindow.startIso)
        .lt("first_visit_at", currentWindow.endIso),

      supabase
        .from("points_transactions")
        .select("id, consumer_id, points, created_at")
        .eq("business_id", businessId)
        .eq("type", "earn")
        .order("created_at", { ascending: false })
        .limit(ACTIVITY_SOURCE_LIMIT),

      supabase
        .from("reward_claims")
        .select("id, consumer_id, reward_id, redeemed_at")
        .eq("business_id", businessId)
        .eq("status", "redeemed")
        .order("redeemed_at", { ascending: false })
        .limit(ACTIVITY_SOURCE_LIMIT),
    ]);

  const failure =
    ledger.error ??
    redemptionsNow.error ??
    redemptionsBefore.error ??
    customers.error ??
    newCustomers.error ??
    recentEarns.error ??
    recentClaims.error;
  if (failure !== null) {
    console.error("[analytics/dashboard] could not read the dashboard metrics", failure);
    return null;
  }

  const ledgerRows = (ledger.data ?? []) as LedgerRow[];
  // The window holds more rows than came back, so every figure derived from
  // them is a floor. Surfaced as a `+` on the value and a muted delta, never
  // presented as a total.
  const ledgerCapped = (ledger.count ?? ledgerRows.length) > ledgerRows.length;
  const entries: LedgerEntry[] = ledgerRows.map((row) => ({
    consumerId: row.consumer_id,
    points: row.points,
    createdAt: row.created_at,
  }));

  const currentEntries = entriesWithin(entries, currentDays);
  const previousEntries = entriesWithin(entries, previousDays);

  const chart = visitsByDay(currentEntries, currentDays);
  const newCustomerCount = newCustomers.count ?? 0;

  return {
    kpis: [
      kpi(
        "Visits, last 7 days",
        countVisits(currentEntries),
        countVisits(previousEntries),
        ledgerCapped,
      ),
      kpi("Points issued, last 7 days", sumPoints(currentEntries), sumPoints(previousEntries), ledgerCapped),
      kpi(
        "Redemptions, last 7 days",
        redemptionsNow.count ?? 0,
        redemptionsBefore.count ?? 0,
        false,
      ),
      {
        label: "Customers, all time",
        value: formatCount(customers.count ?? 0),
        // Not a period comparison: an all-time total has no previous window.
        // The line underneath states the one thing about it that IS a change.
        delta:
          newCustomerCount > 0
            ? { text: `+${formatCount(newCustomerCount)} in the last 7 days`, tone: "trend" }
            : { text: "No new customers in the last 7 days", tone: "muted" },
      },
    ],
    visitsByDay: chart,
    visitsChartLabel: visitsChartLabel(chart, currentDays),
    activity: await buildActivity(
      businessId,
      (recentEarns.data ?? []) as RecentEarnRow[],
      (recentClaims.data ?? []) as RedeemedClaimRow[],
      supabase,
      now,
    ),
    ledgerCapped,
  };
}

type SessionClient = Awaited<ReturnType<typeof createClient>>;

function countRedemptions(
  supabase: SessionClient,
  businessId: string,
  window: { startIso: string; endIso: string },
) {
  // Doc 40 reward funnel: the redemption is the counter event, recorded in
  // `redemptions` with its own `redeemed_at`. Counted with a HEAD request so
  // the tile costs an index scan and no row transfer.
  return supabase
    .from("redemptions")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .gte("redeemed_at", window.startIso)
    .lt("redeemed_at", window.endIso);
}

function kpi(label: string, current: number, previous: number, capped: boolean): DashboardKpi {
  const delta: KpiDelta = capped
    ? { text: "Too much activity in this window to compare", tone: "muted" }
    : periodDelta(current, previous);
  return { label, value: formatCount(current, capped), delta };
}

// ---------------------------------------------------------------- activity

/**
 * The recent-activity feed: earn ledger rows and redeemed reward claims,
 * merged newest first.
 *
 * The two sources describe two different events and never restate each other:
 * a `redeem` ledger row and its `reward_claims` row are the SAME event, so the
 * ledger half is filtered to `type='earn'` and the redemption half is read
 * from the claim. Listing both would double-count every redemption.
 */
async function buildActivity(
  businessId: string,
  earns: readonly RecentEarnRow[],
  claims: readonly RedeemedClaimRow[],
  supabase: SessionClient,
  now: Date,
): Promise<ActivityItem[]> {
  if (earns.length === 0 && claims.length === 0) return [];

  const consumerIds = [
    ...earns.map((row) => row.consumer_id),
    ...claims.map((row) => row.consumer_id),
  ];
  const rewardIds = claims.map((row) => row.reward_id);

  const [names, rewardNames] = await Promise.all([
    loadDisplayNames(consumerIds),
    loadRewardNames(supabase, businessId, rewardIds),
  ]);

  // "A customer" rather than an invented name: the feed's job is to report
  // what happened, and it can do that truthfully without one.
  const who = (consumerId: string): string => names.get(consumerId) ?? "A customer";

  const items: Array<ActivityItem & { at: number }> = [];

  for (const row of earns) {
    const at = new Date(row.created_at);
    items.push({
      id: `earn-${row.id}`,
      icon: "document_scanner",
      text: `${who(row.consumer_id)} earned ${formatPoints(row.points)}`,
      timeLabel: relativeTime(at, now),
      at: at.getTime(),
    });
  }

  for (const row of claims) {
    if (row.redeemed_at === null) continue;
    const at = new Date(row.redeemed_at);
    const reward = rewardNames.get(row.reward_id);
    items.push({
      id: `redeem-${row.id}`,
      icon: "redeem",
      text:
        reward === undefined
          ? `${who(row.consumer_id)} redeemed a reward`
          : `${who(row.consumer_id)} redeemed ${reward}`,
      timeLabel: relativeTime(at, now),
      at: at.getTime(),
    });
  }

  return items
    .sort((a, b) => b.at - a.at)
    .slice(0, ACTIVITY_LIMIT)
    .map((item) => ({
      id: item.id,
      icon: item.icon,
      text: item.text,
      timeLabel: item.timeLabel,
    }));
}

async function loadRewardNames(
  supabase: SessionClient,
  businessId: string,
  rewardIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(rewardIds));
  if (unique.length === 0) return new Map();

  // Tenant-scoped by both RLS (`rewards_staff_select`) and the explicit
  // predicate, so a claim carrying another tenant's reward id resolves to no
  // name rather than to that tenant's wording.
  const { data, error } = await supabase
    .from("rewards")
    .select("id, name")
    .eq("business_id", businessId)
    .in("id", unique);

  if (error !== null) {
    console.error("[analytics/dashboard] reward name read failed", error);
    return new Map();
  }
  return new Map(
    ((data ?? []) as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]),
  );
}

/**
 * Display names for the consumers in the feed.
 *
 * TENANCY NOTE, since this is the one read here with no `business_id`
 * predicate: `profiles` has no tenant. The ids handed in are always taken from
 * rows that a business-scoped query already returned, so the set of names this
 * can reach is exactly the set of people who transacted with THIS business.
 * Only `display_name` is selected; `phone`, `birth_date` and the suspension
 * columns are not the merchant's business and RA 10173 data minimisation says
 * so. This mirrors `loadDisplayNames` in features/receipts/review/queue.ts,
 * which solves the identical problem for the review queue.
 *
 * The service role is required because `profiles` RLS is self-select plus
 * platform admin (migration 0002): no policy lets a merchant read a customer's
 * profile row, so the session client would return an empty set here. A missing
 * service-role key is a degraded path, not a failure: the feed falls back to
 * "A customer" and still reports what happened.
 */
async function loadDisplayNames(consumerIds: readonly string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(consumerIds));
  if (unique.length === 0) return new Map();

  const service = createServiceRoleClient();
  if (service === null) return new Map();

  const { data, error } = await service.from("profiles").select("id, display_name").in("id", unique);

  if (error !== null) {
    console.error("[analytics/dashboard] display name read failed", error);
    return new Map();
  }
  return new Map(
    ((data ?? []) as Array<{ id: string; display_name: string }>).map((row) => [
      row.id,
      row.display_name,
    ]),
  );
}
