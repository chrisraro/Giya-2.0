# 40 — Analytics Platform

Analytics answers three audiences with one strategy: **business dashboards** (`32-business-portal.md`), **platform admin** (`31-admin-portal.md`), and **consumer personal stats** [V1] (`33-consumer-pwa.md`). No separate event store exists at MVP: domain tables are the events, nightly rollups are the read model.

## Strategy

1. **Transactional tables are truth.** `receipts`, `points_transactions`, `reward_claims`, `redemptions`, `business_customers`, `notifications`, `fraud_signals`, `ai_usage_events` — analytics never writes to them and never maintains parallel counters.
2. **Nightly `analytics.daily_rollup`** (`39-background-jobs.md`) writes `analytics_daily_business` (`../20-data/25-schema-platform.md`) for the just-closed Manila day. Dashboards read rollups for any historical range.
3. **Today is live.** The current Manila day is computed with live queries over the transactional tables (tenant-scoped, index-backed) and unioned with rollups client-transparently by the analytics service (`src/features/analytics/server/`).
4. **[SCALE] read replica:** analytics repositories are flagged `readPreference: 'replica'` today (`../10-architecture/12-multi-tenancy-rls.md`); cutover is configuration.
5. **Product analytics** (page views, funnels on the app itself) is Vercel Analytics (`../10-architecture/11-tech-stack.md`) — not this module. A custom platform event table is [SCALE] (see Schema deltas).

## Timezone rule (canon)

All business meaning is **Asia/Manila** (fixed UTC+8, no DST). The **day** of any event is:

```sql
(event_ts AT TIME ZONE 'Asia/Manila')::date
```

- For receipts, `event_ts` = `receipt_date` when parsed, else `created_at` (submission time). The rollup and visit logic use this single expression, wrapped as `private.manila_day(timestamptz)` (immutable SQL function) so live queries and rollups can never disagree.
- Rollup runs 01:40 Manila (`39-background-jobs.md` schedule) and processes `day = yesterday(Manila)`.
- Weeks are Mon–Sun Manila; months are calendar months Manila.
- Range filters translate a Manila date range to a UTC `timestamptz` half-open interval **once, at the query edge** (`day D` ⇒ `[D 00:00+08, D+1 00:00+08)`), so hot-path queries stay sargable on `created_at` indexes; `manila_day()` appears only in GROUP BYs over pre-filtered sets, never as a WHERE-clause function over a whole table.

## Event taxonomy (canonical definitions)

| Term | Definition (canon) |
|---|---|
| **Visit** | A distinct `(user_id, business_id, manila_day)` with ≥1 **approved** receipt. **Multiple same-day approved receipts at the same business = 1 visit** for all visit counting (`visit_count`, loyalty stamps default, retention). **All approved receipts count for spend.** This matches `loyalty_programs.max_stamps_per_day` default 1 (`../20-data/23-schema-campaigns.md`) and is the anti-gaming rule: splitting one purchase into three receipts buys points, never extra visits. |
| **New customer** (for business B, day D) | `business_customers.first_visit_at` falls on Manila day D. `first_visit_at` is set by the points engine on first approved receipt (`35-points-engine.md`). |
| **Returning customer** (day D) | Had a visit on D and `first_visit_at` < start of D. `new + returning = distinct visitors that day`. |
| **Active consumer (WASC)** | North star per `../00-product/00-vision.md`: consumer with ≥1 approved (valid) receipt in a trailing 7-day window. Computed platform-wide from `receipts`; `consumers.last_scan_at` is the cheap approximation for segmentation, `receipts` is the reporting truth. |
| **Active business** | Verified business (`status='active'`) with ≥1 campaign in status `active` (`../00-product/00-vision.md` growth metric). |

## Business analytics — exact formulas

All queries are tenant-scoped (`business_id = $1`) and, unless marked live, read `analytics_daily_business` for closed days.

| Metric | Formula (over exact tables/columns) |
|---|---|
| Revenue (observed) | `sum(receipts.total_centavos) where status='approved'` per day → rollup `gross_sales_centavos`. This is *scanned* revenue — a floor of true revenue; dashboards label it "tracked sales", never "sales". |
| Visits | `count(distinct (user_id, manila_day(coalesce(receipt_date, created_at))))` over approved receipts → rollup `visits` (see Schema deltas). `receipts_approved` counts receipts, not visits. |
| New / returning | Per definitions above → rollup `new_customers`, `returning_customers`. |
| Points issued / redeemed | `sum(points) where type='earn'` / `abs(sum(points)) where type='redeem'` from `points_transactions` → rollup `points_earned`, `points_redeemed`. |
| Retention (cohort) | Cohort = Manila month of `business_customers.first_visit_at`. Retained in month N = ≥1 approved receipt (a visit) at this business in month N. Matrix query over `receipts` grouped by cohort month × activity month; [SCALE] precomputed into a monthly rollup if slow. |
| Top products | `receipt_line_items` joined to approved `receipts`, `where product_id is not null`: rank by `sum(qty)` and `sum(line_total_centavos)`. Coverage caveat surfaced in UI: only OCR-matched lines count (`match_score`, `36-receipt-ocr-pipeline.md`); an "unmatched lines %" tile keeps this honest. |
| Reward funnel | `reward_claims` per reward: claimed → redeemed (`status`, join `redemptions`). Redemption rate = `count(status='redeemed') / count(*)` per `../00-product/00-vision.md`; expiry leakage = `status='expired'` share. |
| CLV (simple) | `business_customers.lifetime_spend_centavos` (and `lifetime_points`); distribution + top-decile tiles. Predictive CLV [SCALE]. |

### Campaign performance & attribution (honest rules)

Attribution is **provenance-based, not causal**:

- **Points campaigns** (loyalty/multiplier/bonus/birthday/referral): `points_transactions.campaign_id` is stamped by the points engine when a campaign's rule contributed (`rule_snapshot` holds the detail). Points attributed = `sum(points) where campaign_id=$c and type in ('earn','referral_bonus')`.
- **Reward campaigns:** claims/redemptions via `rewards.campaign_id` → `reward_claims` → `redemptions`; points spent = `reward_claims.points_spent`.
- **Push/email sends:** delivery funnel from `notifications` where `campaign_id=$c`: sent → delivered → read (`status`, `read_at`).
- **Window activity:** receipts approved and visits during `[campaigns.starts_at, ends_at]` at the business, shown as "activity during campaign".

**Documented limits (rendered in the UI, not hidden):** window activity is correlation — no holdout groups at MVP; a visit "after a push" is not click-attributed (no per-notification open→scan join at MVP; deep-link open tracking is a [V1] event, see deltas); overlapping campaigns each claim their own provenance rows and are not de-duplicated across campaigns (a receipt earning under a base rule + Friday multiplier attributes the multiplier's increment to the multiplier campaign via `rule_snapshot`, never the whole earn).

### Engine hooks → where analytics events land (no separate event store at MVP)

| Emitting engine | Event | Lands in |
|---|---|---|
| Campaign engine (`34-campaign-engine.md`) | lifecycle transitions (activate/pause/end) | `audit_logs` (`action='campaign.*'`) + `campaigns.status` |
| Campaign engine (F4 fan-out) | send/delivery/read per recipient | `notifications` (`campaign_id`, `status`, `sent_at`, `read_at`) |
| Points engine (`35-points-engine.md`) | earn/redeem/adjust/expire/clawback/referral_bonus | `points_transactions` (`campaign_id`, `rule_snapshot`, `receipt_id`, `claim_id`) |
| Points engine | CRM counter maintenance | `business_customers` (`visit_count`, `first_visit_at`, `last_visit_at`, `lifetime_spend_centavos`, `lifetime_points`) same-transaction |
| Receipt pipeline (`36-receipt-ocr-pipeline.md`) | status transitions + confidences | `receipts` (`status`, `match_confidence`, `parse_confidence`, `reject_reason`, `processed_at`), `ocr_results` |
| Fraud engine (`37-fraud-detection.md`) | every tripped signal | `fraud_signals` (kept even on approved receipts — scoring history) |
| Rewards | claim/redeem funnel | `reward_claims`, `redemptions` |
| AI platform (`38-ai-rag-platform.md`) | usage + cost | `ai_usage_events`, `ai_messages` (latency, cache, feedback) |

Product analytics (page views, in-app funnels) stays in Vercel Analytics; a custom event table is [SCALE] (see Schema deltas).

## Platform analytics (admin) [MVP basic, V1 dashboards]

| Metric | Source |
|---|---|
| Growth | `businesses` by `status`/`verified_at`/`city_id`; `consumers` signups; WASC trend |
| GMV proxy | `sum(analytics_daily_business.gross_sales_centavos)` platform-wide (labeled "tracked GMV") |
| Scan funnel | `receipts` counts by `status` per day: submitted → auto-approved vs `review` → approved/rejected; auto-approval rate vs roadmap targets (≥70% MVP, ≥85% V1, `../00-product/02-roadmap.md`); `reject_reason` breakdown |
| AI/OCR usage + cost | `ai_usage_events` by `kind` (`chat`,`embedding`,`ocr`,`parse_assist`,`analytics`): `units`, `sum(cost_micros)`; per-tenant top spenders; AI cost per WASC (`../00-product/00-vision.md` guardrail) |
| Fraud | `fraud_signals` by `signal`/`severity`; fraud leak rate = clawed-back points (`points_transactions.type='clawback'`) ÷ points earned, trailing 30d |
| Queue/ops health | `jobs` metrics per `39-background-jobs.md` (rendered in admin Queue Status) |

Platform-wide rollup table `analytics_daily_platform` proposed in Schema deltas (until then, admin range queries aggregate `analytics_daily_business` + live queries).

## Consumer analytics [V1]

Personal stats screen: points earned per business (`points_transactions` where `consumer_id = auth.uid()` — P3 RLS self-select), visits, rewards redeemed, and **savings estimate** = `sum(promotions.amount_off_centavos)` equivalents is not computable honestly — canon: savings estimate = sum over redeemed claims of the reward's peso-equivalent when the business sets one (see deltas: `rewards.value_centavos`), else shown as "N rewards redeemed". No invented peso values.

## Rollup implementation sketch (`analytics.daily_rollup` worker)

Per chunk of businesses, one set-based statement per column family — never row-by-row loops:

```sql
insert into analytics_daily_business as adb
  (business_id, day, receipts_approved, receipts_rejected, gross_sales_centavos,
   points_earned, points_redeemed, new_customers, returning_customers,
   rewards_claimed, rewards_redeemed, ai_questions)
select r.business_id, $day,
       count(*) filter (where r.status = 'approved'),
       count(*) filter (where r.status = 'rejected'),
       coalesce(sum(r.total_centavos) filter (where r.status = 'approved'), 0),
       …  -- points/customers/rewards/ai sub-aggregates joined per business (same day window)
from receipts r
where r.created_at >= $day_start_utc and r.created_at < $day_end_utc
  and r.business_id = any($chunk_business_ids)
group by r.business_id
on conflict (business_id, day) do update set
  receipts_approved = excluded.receipts_approved,
  -- … every column: full overwrite, convergent
  gross_sales_centavos = excluded.gross_sales_centavos;
```

- Sub-aggregates: `points_earned/points_redeemed` from `points_transactions` (`type`, sign convention per `../20-data/23-schema-campaigns.md`); `new_customers/returning_customers` from `business_customers.first_visit_at` vs the day's visitor set; `rewards_claimed/rewards_redeemed` from `reward_claims.claimed_at`/`redemptions.redeemed_at`; `ai_questions` from `ai_messages` (role `user`) joined via `ai_conversations.business_id`.
- Businesses with zero activity on a day get **no row** (absence = zeros; dashboard layer fills gaps client-side). This keeps the table proportional to activity, not `businesses × days`.
- Every column is overwritten on conflict — a partial previous run can never leave a stale mixed row.

## Dashboard query patterns

- **Tiles:** Tremor blocks (`../10-architecture/11-tech-stack.md`) fed by the analytics service; each tile = one named query in `src/features/analytics/server/queries.ts` with a registered cache key. Custom visuals (cohort triangle, funnel) drop to Recharts per the Tremor-first rule.
- **Endpoint registry** (aggregate GETs, envelope per `../10-architecture/13-api-standards.md`; role: owner/manager/marketing per matrix `../00-product/01-personas-roles.md`):
  - `GET /api/v1/businesses/{businessId}/analytics/overview?range=` — KPI tiles [MVP]
  - `GET …/analytics/sales-series?range=&grain=day|week` [MVP]
  - `GET …/analytics/customers?range=` — new/returning, segments [V1]
  - `GET …/analytics/retention?months=6` — cohort matrix [V1]
  - `GET …/analytics/top-products?range=&limit=` [V1]
  - `GET …/analytics/campaigns/{campaignId}` — performance detail [V1]
  - `GET …/analytics/rewards?range=` — claim→redeem funnel [V1]
  - `GET /api/v1/admin/analytics/…` — platform equivalents (admin roles) [V1]
  - `GET /api/v1/me/stats` — consumer personal stats [V1]
- **Ranges:** presets 7d/30d/90d/custom read rollups; "today" appended live and marked `partial: true` in the response `meta` so charts can style the in-progress point.
- **Caching:** Redis `{env}:analytics:biz:{business_id}:{tile}:{range}` **TTL 300s** (5 min staleness is acceptable for dashboards; today-tiles accept it too). Invalidation is TTL-only — no event invalidation complexity for aggregates.
- **Export:** every dashboard offers "Export CSV" → creates an `exports` row (`kind='campaign_report'`, `'customers_csv'`, …) and enqueues `exports.generate` [V1] (`39-background-jobs.md`); UI links the signed URL when `exports.status='succeeded'`.
- Heavy tables (top customers, top products) paginate server-side per TanStack Table rules (`../10-architecture/11-tech-stack.md`).

## Reference queries (copy-paste starting points)

WASC (platform, trailing 7 days, live):

```sql
select count(distinct r.user_id) as wasc
from receipts r
where r.status = 'approved'
  and r.created_at >= now() - interval '7 days';
```

Retention cohort matrix (one business, months as Manila calendar months):

```sql
with cohort as (
  select bc.consumer_id,
         date_trunc('month', bc.first_visit_at at time zone 'Asia/Manila')::date as cohort_month
  from business_customers bc
  where bc.business_id = $1 and bc.first_visit_at is not null
), activity as (
  select distinct r.user_id as consumer_id,
         date_trunc('month', coalesce(r.receipt_date, r.created_at) at time zone 'Asia/Manila')::date as active_month
  from receipts r
  where r.business_id = $1 and r.status = 'approved'
)
select c.cohort_month,
       (a.active_month - c.cohort_month) / 30 as month_n,   -- rendered as month offset client-side
       count(distinct a.consumer_id) as retained
from cohort c join activity a using (consumer_id)
where a.active_month >= c.cohort_month
group by 1, 2 order by 1, 2;
```

Visits for one day (the canon dedup rule, live-today tile):

```sql
select count(distinct r.user_id) as visits
from receipts r
where r.business_id = $1 and r.status = 'approved'
  and coalesce(r.receipt_date, r.created_at) >= $day_start_utc
  and coalesce(r.receipt_date, r.created_at) <  $day_end_utc;
```

These live in `src/features/analytics/server/queries.ts` as named, unit-tested functions (`../50-ops/51-testing-strategy.md` formula tests) — the SQL here is documentation of intent, the code is the artifact.

## Data quality

- **Rollup idempotency:** `analytics.daily_rollup` computes each business-day fully from source tables and **upserts on `(business_id, day)`** (`insert … on conflict (business_id, day) do update set <every column>`). Reruns converge; partial failures re-run the failed chunk only (`dedupe_key = day:chunk`).
- **Late data:** receipts approved after their day closed (human review queue) are captured by re-rolling the trailing **3 Manila days** every night, not just yesterday. Reviews older than 3 days trigger a targeted re-roll of that `(business_id, day)` via an event hook in the review service.
- **Backfill procedure:** `pnpm rollup:backfill --from=YYYY-MM-DD --to=YYYY-MM-DD [--business=<id>]` enqueues `analytics.daily_rollup` jobs per day (chunked, jittered per `39`); safe at any time because upserts are convergent. Used after formula changes — a formula change PR must state whether history is re-rolled (and update this doc).
- **Consistency check:** `integrity.balance_check` (`39`) covers ledger-vs-balance drift; a monthly spot-check compares `sum(gross_sales_centavos)` vs a direct `receipts` aggregate for 100 sampled businesses and alerts on mismatch (`../50-ops/52-monitoring-observability.md`).

## Phasing

| Capability | Phase |
|---|---|
| Rollup job + basic KPI tiles (sales, receipts, points, new customers) | [MVP] |
| Retention cohorts, top products, campaign performance, segments overlays, exports | [V1] |
| Consumer personal stats | [V1] |
| Admin AI/OCR dashboards, fraud dashboards | [V1] |
| Read replica, predictive CLV, custom event store, precomputed cohort tables, AI narrative insights (`38-ai-rag-platform.md`) | [SCALE] |

## Schema deltas proposed

Ratified into `../20-data/26-schema-amendments.md`.

- `analytics_daily_business.visits` — **ACCEPTED** [MVP] (A25.3).
- `analytics_daily_business.receipts_submitted` — **ACCEPTED** [MVP] (A25.3).
- New table `analytics_daily_platform` — **ACCEPTED** [V1] (A25.4).
- `rewards.value_centavos` — **ACCEPTED** [V1] (A23.4).
- `notifications.opened_at` — **ACCEPTED** [V1] (A25.5).
- Custom `events` table — **DEFERRED [SCALE]**: only if product analytics outgrows Vercel Analytics + domain tables; sketch recorded in 26 (A25.8).
