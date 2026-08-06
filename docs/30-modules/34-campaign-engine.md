# 34 — Campaign Engine (the heart of Giya)

Storage contract: `../20-data/23-schema-campaigns.md`. Roles: `../00-product/01-personas-roles.md`. API conventions: `../10-architecture/13-api-standards.md`. Queue mechanics: `39-background-jobs.md`. Points math delegated to `35-points-engine.md`.

## 1. Concept: everything is a campaign

A `campaigns` row is the universal container — type, lifecycle `status`, schedule (`starts_at`/`ends_at`/`timezone`/`recurrence`), `audience`, `budget`, `priority`, `is_stackable`. Type-specific configuration lives in payload tables, joined by `campaign_id`. The engine is **data-driven rules, not code-per-type** (`../00-product/02-roadmap.md`, rewrite-avoidance): adding a campaign type is a new payload mapping + validation entry, not a new subsystem.

Type → payload mapping (canonical copy in `../20-data/23-schema-campaigns.md`; the campaign service enforces it at activation):

| `campaigns.type` | Required payload row(s) | Phase |
|---|---|---|
| `promotion`, `discount`, `seasonal`, `holiday`, `event` | `promotions` (display + offer) | `promotion` [MVP], rest [V1] |
| `reward` | `rewards` (≥1 active) | [MVP] |
| `loyalty`, `membership` | `loyalty_programs` (+ its prize `rewards` row with `claim_kind='loyalty_completion'`, optional `points_rules`) | `loyalty` [MVP], `membership` [V1] |
| `birthday` | `points_rules` (kind=`multiplier`, `conditions.birthday=true`) and/or `rewards` | [V1] |
| `referral` | `points_rules` (kind=`bonus`, referrer/referee amounts in `conditions`) | [V1] |

The engine owns lifecycle, scheduling, targeting, budget, and stacking. It never computes points (that is `35-points-engine.md`, which asks this engine "which campaigns are live for this receipt?") and never sends notifications inline (it enqueues, `39-background-jobs.md`).

## 2. Lifecycle state machine

States are exactly `campaign_status`: `draft → scheduled → active → paused → ended → archived`. Any transition not in this table is rejected with `409 CAMPAIGN_INVALID_STATE`. All transitions execute in the service layer inside one DB transaction, write an `audit_logs` row (`action` = `campaign.<transition>`), and are idempotent per `Idempotency-Key` (`../10-architecture/13-api-standards.md`).

| # | From → To | Trigger | Who may trigger | Gates |
|---|---|---|---|---|
| T1 | `draft → scheduled` | "schedule" (requires future `starts_at`) | owner, manager, marketing (creator-owned only), super_admin | G1–G5 |
| T2 | `draft → active` | "activate now" | same as T1 | G1–G5 |
| T3 | `scheduled → active` | sweep worker at `starts_at`, or manual "activate now" | system; or roles as T1 | G1–G3 re-checked (cheap subset) |
| T4 | `scheduled → draft` | "unschedule" | owner, manager, marketing (own), super_admin | — |
| T5 | `active → paused` | "pause" | owner, manager, marketing (own); admin (policy violations, pause only — matrix note 4); system (budget exhaustion §6) | — |
| T6 | `paused → active` | "resume" | owner, manager, marketing (own), super_admin (admin **cannot** resume) | G1–G5 full re-run |
| T7 | `active → ended` / `paused → ended` | sweep worker at `ends_at`, or manual "end" | system; owner, manager, super_admin | — |
| T8 | `draft → archived` / `ended → archived` | "archive" (sets `archived_at`) | owner, manager, super_admin | — |
| T9 | any → new `draft` | "duplicate" (new row + deep-copied payload; not a transition of the source) | owner, manager, marketing, super_admin | — |

`archived` is terminal. There is no `ended → active`: relaunching is `duplicate`. An admin-paused campaign can only be resumed by super_admin or after the business appeals (admin lifts by re-flagging is out of scope; the pause reason is stored in the audit row and surfaced in the portal).

### Activation gates (T1/T2/T6 full set)

| Gate | Check | Failure code (422 unless noted) |
|---|---|---|
| G1 Business standing | `businesses.status = 'active'` (verified, not suspended), `deleted_at is null` | `BUSINESS_NOT_VERIFIED` |
| G2 Payload completeness | Required payload row(s) exist per §1 mapping, are `deleted_at is null`, and internally valid (e.g. `promotions.offer_kind='percent_off'` ⇒ `percent_off` set; `reward` campaign has ≥1 `rewards` row with `is_active=true`; `loyalty_programs.reward_id` points at a live reward) | `CAMPAIGN_PAYLOAD_INCOMPLETE` |
| G3 Schedule sanity | `ends_at` null or in the future; `ends_at > starts_at` (also a DB check); T1 additionally requires `starts_at` > now; `recurrence` (if set) parses per §3 schema | `CAMPAIGN_SCHEDULE_INVALID` |
| G4 Budget sanity | `budget` parses per §6 schema; if `type='reward'`: `max_redemptions` (when set) ≥ 1 and consistent with summed `rewards.total_inventory` (warn-only if larger); `max_total_points` ≥ largest single-award possibility (warn-only) | `CAMPAIGN_BUDGET_INVALID` |
| G5 Targeting sanity | `audience` parses per §5 schema; referenced `cities` exist in `ref_cities` | `VALIDATION_FAILED` |

### Side effects per transition

| Transition | Side effects (post-commit, mostly enqueued) |
|---|---|
| → `active` (T2/T3/T6) | Invalidate caches: `revalidateTag('biz:{business_id}:campaigns')` + delete Redis keys `{env}:campaigns:live:{business_id}`; enqueue `ai.embed_refresh` for the campaign's public text (name/description/promotion terms) so the assistant answers about live promos (`38-ai-rag-platform.md`) [V1]; if the campaign has a marketing send configured, enqueue audience materialization → `notify.push` batches (flow F4, `../10-architecture/10-system-architecture.md`) [V1]; emit `campaign.activated` analytics event (§10) |
| → `paused` (T5) | Cache invalidation as above; live-eligibility Redis key deleted so `35` stops applying its rules immediately; if system-triggered (budget, task 1.2), the check runs post-commit and best-effort out of the award path itself (not this side-effect list, which describes the portal/state-machine's own transitions) and raises `kind='campaign_budget_exhausted'` in-app + email to the business owner only; emit `campaign.paused` with `reason` |
| → `ended` (T7) | Cache invalidation; enqueue `ai.embed_refresh` removal/downrank of campaign chunks [V1]; final performance rollup job for `analytics_daily_business` (`40-analytics.md`); emit `campaign.ended` |
| → `scheduled` (T1) | No cache changes (not yet public); the sweep (§4) picks it up via `campaigns_active_window_idx` — no per-campaign timer is registered |
| → `archived` (T8) | Sets `archived_at`; hidden from default portal lists; QR codes pointing at it resolve to a "campaign ended" page (§9) |

## 3. Scheduling, timezone, recurrence

- `starts_at`/`ends_at` are `timestamptz` stored UTC. `campaigns.timezone` (default `'Asia/Manila'`) is the *interpretation* timezone: portal date-pickers convert wall-clock input to UTC using it, and all recurrence/window/condition evaluation happens in it. PH has no DST; do not hard-code the +08:00 offset anyway — use `Temporal`/date-fns-tz with the IANA zone.
- Null `starts_at` = live immediately upon activation; null `ends_at` = runs until manually ended or budget-paused.
- **Recurrence [V1]** (`campaigns.recurrence` JSONB) does **not** flip `status`. A recurring campaign stays `active` for its whole `starts_at..ends_at` envelope; recurrence gates *eligibility* — whether the campaign is "live" at a given instant:

```ts
// src/features/campaigns/lib/live.ts — pure, shared client/server (../10-architecture/14-development-standards.md)
export const recurrenceSchema = z.object({
  rrule: z.string().max(200),   // RFC 5545 RRULE body, e.g. "FREQ=WEEKLY;BYDAY=FR"
  windows: z.array(z.object({
    from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),  // "11:00" wall clock in campaigns.timezone
    to:   z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })).max(4).optional(),        // omitted = whole day of each occurrence
}).strict();

export function isCampaignLive(c: CampaignRow, at: Date): boolean {
  if (c.status !== 'active') return false;
  if (c.starts_at && at < c.starts_at) return false;
  if (c.ends_at && at >= c.ends_at) return false;
  if (!c.recurrence) return true;
  const local = toZoned(at, c.timezone);               // Asia/Manila wall clock
  return occursOn(c.recurrence.rrule, local)           // rrule lib, date-level match
      && inAnyWindow(c.recurrence.windows, local);     // no windows = true
}
```

`35-points-engine.md` calls `isCampaignLive(campaign, receipt.receipt_date)` — receipt time, never processing time. Windows that cross midnight (`from > to`, e.g. `22:00→02:00`) span into the next day and belong to the occurrence date of `from`.

### Sweep worker — queue `campaigns.sweep`

QStash schedule, every 5 minutes (`39-background-jobs.md` registry). One idempotent job per tick (`jobs.dedupe_key = window_ts` per the registry):

```sql
-- driven by campaigns_active_window_idx (partial: status in ('scheduled','active','paused'))
update campaigns set status='active'  where status='scheduled' and starts_at <= now() and deleted_at is null;
update campaigns set status='ended'   where status='active'    and ends_at   <= now() and deleted_at is null;
-- (paused campaigns past ends_at are ended too, second statement variant)
```

In practice the service selects candidate ids first, then runs each transition through the same state-machine function as the API (so gates on T3 and side effects fire per campaign, chunked 100/job). Latency contract: state visible within one sweep interval (≤ ~6 minutes) of the boundary; consumer-facing "live" checks additionally use `isCampaignLive` so sweep lag never shows an expired promo as claimable.

**As shipped (task 2.1, `supabase/migrations/0053_campaigns_sweep.sql` +
`0054_campaigns_sweep_review_fixes.sql`), this is a single SQL `security
definer` function (`public.sweep_campaigns`), not a TypeScript service loop
through the shared state-machine function** — `pg_cron` can only call SQL. It
re-checks G1 (business standing) alone for T3, not the full gate set this
paragraph implies (see the migration's own header for why G2/G3 are
out of scope for a sweep), and T7 is unconditional. It does **not** fire the
cache-invalidation / `ai.embed_refresh` / marketing-send side effects listed
under "Side effects per transition" above — those live in
`src/features/campaigns/server/service.ts`'s `emitLifecycleEvent`, which a
plpgsql function cannot call. Recorded as a known gap in
`supabase/README.md`'s "Known limitations".

## 4. Targeting / audience [V1]

`campaigns.audience` JSONB. Empty object `{}` (default) = every non-blacklisted customer of the business. All keys AND together.

```ts
// src/features/campaigns/schemas.ts
export const audienceSchema = z.object({
  segments:       z.array(z.enum(['regular', 'vip'])).nonempty().optional(), // 'blacklisted' is not targetable
  min_visits:     z.number().int().min(1).max(1000).optional(),              // business_customers.visit_count >=
  cities:         z.array(z.string().uuid()).max(20).optional(),             // consumers.city_id in ref_cities
  birthday_month: z.boolean().optional(),                                    // profiles.birth_date month = current month (Asia/Manila)
}).strict();
```

**Resolution to a recipient set** (marketing sends, flow F4) and **eligibility checks** (claim/award time) use the same predicate, evaluated in two places:

- *Set materialization* (sends): chunked keyset scan over `business_customers` joined to `consumers`/`profiles`, filtered by the audience predicate, 500 recipients per `notify.push` job.
- *Point-in-time check* (claim, award, campaign visibility on the consumer PWA): single-row predicate against the caller's `business_customers` row.

Segment interactions (hard rules, applied regardless of `audience`):
- `segment='blacklisted'` ⇒ excluded from every audience, cannot claim rewards, earns no campaign multipliers/bonuses (base earning is also blocked at receipt approval — `37-fraud-detection.md`).
- `segment='vip'` matches `segments:['vip']`; a campaign with no `segments` key includes both `regular` and `vip`.
- A consumer with no `business_customers` row yet (first interaction) counts as `regular` with `visit_count=0` — so `min_visits:1` excludes brand-new customers, `{}` includes them.

## 5. Budget guardrails

`campaigns.budget` JSONB; all keys optional (absent = unlimited):

```ts
export const budgetSchema = z.object({
  max_total_points:   z.number().int().positive().optional(), // cap on points granted via this campaign
  max_redemptions:    z.number().int().positive().optional(), // cap on reward_claims (reward-family)
  per_customer_limit: z.number().int().positive().optional(), // per-consumer claims/bonus grants
}).strict();
```

| Guardrail | Enforced where | How |
|---|---|---|
| `max_total_points` | **Award time** — `35-points-engine.md` pipeline, before writing the ledger row | Running total = the sum, over this business's earn rows, of what EACH row's own `rule_snapshot` attributes to this campaign (task 1.2, `private.campaign_points_awarded`) — **not** `select sum(points) where campaign_id=$1`. `points_transactions.campaign_id` names only the receipt's *primary* applied campaign (`35-points-engine.md` §3, "the primary applied campaign or null"), so a naive sum on that column is wrong in both directions: it over-charges a capped campaign for points a *different* campaign or the base rule actually granted whenever the capped one happens to be primary on a big receipt, and it never counts a capped campaign's contribution at all on any receipt where it stacks as a *non-primary* candidate — silently defeating its own cap. The correct total reads each earn row's `rule_snapshot.multipliers`/`.bonuses` entries (already decorated with `campaign_id` per entry, §6) and sums only the entries naming this campaign, excluding any row later clawed back/reversed. If `total + pending_contribution > max_total_points`, the *whole* contribution from this campaign is skipped for this receipt (never partially awarded; base and every other campaign still pay) and exhaustion fires |
| `max_redemptions` | **Claim time** — inside the claim transaction (`35` §6) | `count(*) from reward_claims where business_id=$1 and reward_id in (campaign's rewards) and status in ('claimed','redeemed')` checked under the same lock that decrements `rewards.remaining` |
| `per_customer_limit` | **Claim time** for reward-family (counts that consumer's non-cancelled `reward_claims`); **award time** for multiplier/bonus campaigns (counts that consumer's earn rows whose OWN `rule_snapshot` attributes a positive contribution to this campaign — task 1.2, `private.campaign_customer_earn_count`; same non-primary-safe attribution as `max_total_points` above, not a raw `campaign_id` filter) | Note: `rewards.per_customer_limit` also exists per reward row; the stricter of the two applies |

**On exhaustion** of `max_total_points` (task 1.2, `src/features/campaigns/server/exhaustion.ts`): a post-commit, best-effort check writes `campaigns.status = 'paused'` **directly** (an optimistic `status = 'active'` predicate, not a call through the lifecycle state-machine service — the award pipeline runs under the service-role client with no session, and the state-machine service's repo layer needs a session-scoped one), audits `campaign.paused` with `actor_kind='system'` and a `reason` naming the exhaustion, and notifies `kind='campaign_budget_exhausted'` to **the business owner only** (in-app + email — not push: this build has no VAPID keys/push registration, matching every other kind in `src/features/notifications/kinds.ts`; not managers: doc 25/30's registry addresses this kind to the owner). `max_redemptions` exhaustion (reward-family, claim time) is not yet wired to this same pause path. `per_customer_limit` hitting for one consumer is *not* exhaustion — it returns `422 CAMPAIGN_LIMIT_REACHED`/drops the contribution for that consumer only, never pausing the campaign.

Promotion-family campaigns (`offer_kind` discounts shown at the counter) have no in-system redemption event at MVP/V1, so only `max_total_points` (if paired points rules exist) is enforceable for them — see "Schema deltas proposed".

## 6. Stacking & priority

Applies when `35-points-engine.md` has collected all *candidate* `points_rules` (kind `multiplier`/`bonus`) whose campaign `isCampaignLive(receipt_date)` and whose `conditions` match. Semantics of the two columns:

- `campaigns.priority` — ascending sort key; **lower value wins** (schema comment: "lower wins ties"). Default 100.
- `campaigns.is_stackable` — whether this campaign's rules may combine with other campaigns' rules. Rules with `campaign_id is null` (business-default multipliers) are treated as stackable with priority 100.

**Deterministic resolution algorithm:**

1. Sort candidates by `(campaign.priority asc, campaign.created_at asc, campaign.id asc)` — total order, no ties possible.
2. If the first candidate is **non-stackable** → it applies **alone**; all other candidates are dropped.
3. If the first candidate is **stackable** → all stackable candidates apply together; every non-stackable candidate is dropped.
4. Stacked multipliers combine **additively on the extras**, not multiplicatively: `effective = 1 + Σ(mᵢ − 1)`. Bonuses always add after multipliers (each surviving bonus rule contributes `bonus_points` once).

Worked examples (base = 200 pts):

| Live candidates | Resolution | Result |
|---|---|---|
| Friday 2.00× (prio 50, non-stackable); Payday 1.50× (prio 100, stackable) | Sorted: Friday first; non-stackable → alone | 200 × 2.00 = 400 |
| Payday 1.50× (prio 40, stackable); Friday 2.00× (prio 50, non-stackable); Anniversary +50 bonus (prio 100, stackable) | Payday first, stackable → keep stackables, drop Friday | 200 × 1.50 + 50 = 350 |
| Two stackables: 2.00× and 1.50× | effective = 1 + 1.0 + 0.5 = 2.5 | 200 × 2.5 = 500 |

Rounding per rule row (`points_rules.rounding`) applies to each contribution — exact arithmetic in `35-points-engine.md` §4. The chosen candidate set is frozen into the ledger row's `rule_snapshot`, so historical awards are explainable even after campaigns change.

## 7. Campaign types

| Type | Phase | Configures | Consumer experience | Key edge cases |
|---|---|---|---|---|
| `promotion` | [MVP] | `promotions` (`offer_kind` incl. `announcement`, `product_ids` scope, `terms`, `redemption_hint`) | Card on business page + home "Promos"; no in-app claim — shown at counter | `announcement` kind has no offer values; scoped `product_ids` must reference live `products` (`../20-data/22-schema-catalog.md`); expired promo must vanish from ISR-cached pages within cache TTL (60s, `../10-architecture/13-api-standards.md` caching) |
| `reward` | [MVP] | `rewards` rows: `points_cost`, `total_inventory`/`remaining`, `per_customer_limit`, `claim_expiry_days` | Reward catalog → claim with points → QR at counter (`35` §6) | Out-of-stock mid-claim (conditional decrement); campaign paused between claim and redemption — existing claims remain redeemable (claims outlive campaign state), new claims blocked |
| `discount` | [V1] | `promotions` with `percent_off`/`amount_off_centavos` | Like promotion but rendered as an explicit price cut; counter-honored | Discount does not change points math — earning is computed on `receipts.total_centavos` (the paid amount) |
| `referral` | [V1] | `points_rules` kind=`bonus`, referrer/referee amounts in `conditions` (`35` §10) | Consumer shares `consumers.referral_code`; both sides get points when referee's first receipt is approved | Self-referral, ring abuse — guards in `35` §10; budget `max_total_points` counts both sides' grants |
| `event` | [V1] | `promotions` + tight `starts_at..ends_at` window | Time-boxed card ("Anniversary sale Sat only") with countdown | Very short windows rely on `isCampaignLive`, not sweep granularity |
| `seasonal` | [V1] | `promotions` + `recurrence` (e.g. `FREQ=WEEKLY;BYDAY=FR` + lunch `windows`) | Appears only during live windows ("Happy hour 3–6 PM") | Off-window: visible as "returns Friday 15:00" (schedule surfaced), not claim-able/earn-able |
| `birthday` | [V1] | `points_rules` multiplier with `conditions.birthday=true`, and/or a `granted` reward | Auto multiplier during birth month + optional gift reward in wallet | Consumers without `profiles.birth_date` never match; birth-date edits limited 1×/yr (app rule, `../20-data/21-schema-identity.md`) to block month-hopping |
| `holiday` | [V1] | `promotions`, usually with `recurrence` `FREQ=YEARLY` | Same as seasonal, holiday-themed surfaces | PH holidays are business-entered dates; no auto holiday calendar at V1 |
| `membership` | [V1] | `loyalty_programs` (long-horizon, `resets_on_completion=false` typical) + optional `points_rules` (e.g. VIP-only multiplier with `audience.segments=['vip']`) | Tier-like standing card | Distinguished from `loyalty` only by intent/UI; identical machinery |
| `loyalty` | [MVP] | `loyalty_programs`: `program_type`, `target_value`, prize `reward_id`, `min_amount_per_stamp_centavos`, `max_stamps_per_day`, `resets_on_completion` | Stamp card animating per qualifying visit; completion auto-claims prize | Progress semantics + completion in `35` §5; multiple concurrent programs per business is [V1] (`../00-product/02-roadmap.md`) |

## 8. Campaign QRs [V1]

Printable/postable QR linking the physical world to a campaign. Table `qr_codes` (`../20-data/25-schema-platform.md`): `qr_type='campaign'`, `target_id=campaign_id`, unique `short_code` (10-char base58). Consumer-shown reward-redemption QRs are **not** rows here — those are ephemeral signed tokens (`../10-architecture/15-security.md`).

Resolution flow: printed URL `giya.ph/q/{code}` → Next.js public route → service resolves:

1. Look up `qr_codes` by `short_code` (Redis-cached `{env}:qr:{code}`, TTL 300s). Missing → 404 `NOT_FOUND`.
2. `is_active=false` or `deleted_at` set → landing page "link retired" (HTTP 410 semantics on the API variant, code `QR_INACTIVE`).
3. Increment scan counter: `INCR {env}:qr:scans:{id}` in Redis; the `qr.scan_flush` job (`39-background-jobs.md` registry) flushes counters into `qr_codes.scan_count` every 5 min (no synchronous write on the read path).
4. Redirect by target state: campaign `active` (and `isCampaignLive`) → campaign page on the business profile; `scheduled` → teaser page with start time; `paused`/`ended`/`archived` → business page with "this promo has ended".
5. Emit `campaign.qr_scanned` analytics event (§10) with `qr_id`, `campaign_id`, `business_id`.

Management: owner/manager/marketing create QRs from the portal (`POST .../qr-codes`), download as PNG/SVG print assets (client-side generation).

## 9. API surface

All under `/api/v1`, envelope/pagination/idempotency per `../10-architecture/13-api-standards.md`. Portal mutations may also ship as Server Actions with identical validation and authz; the state-machine service is shared.

| Method & path | Purpose | Roles | Notable errors |
|---|---|---|---|
| `GET /businesses/{businessId}/campaigns?status=&type=&cursor=` | List (portal) | owner, manager, marketing, admin (read, audited) | — |
| `POST /businesses/{businessId}/campaigns` | Create draft (container + inline payload draft) | owner, manager, marketing | `VALIDATION_FAILED` |
| `GET /businesses/{businessId}/campaigns/{id}` | Detail incl. payload + computed live/budget state | owner, manager, marketing, admin | `NOT_FOUND` |
| `PATCH /businesses/{businessId}/campaigns/{id}` | Edit; full edits in `draft`/`scheduled`; in `active`/`paused` only `name`, `description`, `image_url`, `ends_at` (extend), `budget` (raise) | owner, manager, marketing | `CAMPAIGN_INVALID_STATE` |
| `POST /businesses/{businessId}/campaigns/{id}/activate` | T2/T3 manual (idempotent) | owner, manager, marketing (own) | `CAMPAIGN_INVALID_STATE`, `CAMPAIGN_PAYLOAD_INCOMPLETE`, `BUSINESS_NOT_VERIFIED`, `CAMPAIGN_SCHEDULE_INVALID`, `CAMPAIGN_BUDGET_INVALID` |
| `POST /businesses/{businessId}/campaigns/{id}/schedule` | T1 (body: `starts_at`, optional `ends_at`) | owner, manager, marketing (own) | as activate + `CAMPAIGN_SCHEDULE_INVALID` |
| `POST /businesses/{businessId}/campaigns/{id}/pause` | T5 | owner, manager, marketing (own) | `CAMPAIGN_INVALID_STATE` |
| `POST /businesses/{businessId}/campaigns/{id}/resume` | T6 | owner, manager, marketing (own) | activate-gate errors |
| `POST /businesses/{businessId}/campaigns/{id}/end` | T7 manual | owner, manager | `CAMPAIGN_INVALID_STATE` |
| `POST /businesses/{businessId}/campaigns/{id}/archive` | T8 | owner, manager | `CAMPAIGN_INVALID_STATE` |
| `POST /businesses/{businessId}/campaigns/{id}/duplicate` | T9 → new draft | owner, manager, marketing | — |
| `GET /businesses/{businessId}/campaigns/public` | Consumer-facing live campaigns for a business page (public, cached 60s) | public | — |
| `POST /businesses/{businessId}/qr-codes` · `GET …` · `PATCH …/{id}` | Campaign QR management [V1] | owner, manager, marketing | `VALIDATION_FAILED` |
| `GET /qr-codes/{shortCode}` | Public short-code resolution (§8; web route `/q/{code}` wraps it) | public | `NOT_FOUND`, `QR_INACTIVE` |
| `POST /admin/campaigns/{id}/pause` | Admin policy pause (reason required, audited) | admin, super_admin | `CAMPAIGN_INVALID_STATE` |

### Domain error codes registered (extends `../10-architecture/13-api-standards.md` registry)

| HTTP | Code | Meaning |
|---|---|---|
| 409 | `CAMPAIGN_INVALID_STATE` | Transition not allowed from current status |
| 422 | `CAMPAIGN_PAYLOAD_INCOMPLETE` | Missing/invalid payload row for the campaign type (gate G2) |
| 422 | `CAMPAIGN_SCHEDULE_INVALID` | Dates/recurrence fail gate G3 |
| 422 | `CAMPAIGN_BUDGET_INVALID` | Budget JSONB fails gate G4 |
| 422 | `CAMPAIGN_LIMIT_REACHED` | Caller hit `per_customer_limit` for this campaign |
| 409 | `CAMPAIGN_BUDGET_EXHAUSTED` | Claim/award rejected because a campaign-wide cap is spent (campaign auto-pausing) |
| 410 | `QR_INACTIVE` | Short code exists but QR is deactivated/deleted |

(`BUSINESS_NOT_VERIFIED` is already in the shared registry.)

## 10. Analytics hooks

The engine emits domain events consumed by `40-analytics.md` (event taxonomy) and, where flagged, `39-background-jobs.md` job triggers. All events carry `business_id`, `campaign_id`, `campaign_type`, `request_id`, actor.

| Event | Emitted when | Extra payload |
|---|---|---|
| `campaign.created` / `campaign.updated` | CRUD | changed fields list |
| `campaign.activated` / `campaign.paused` / `campaign.resumed` / `campaign.ended` / `campaign.archived` | State machine transitions (incl. system/sweep, with `trigger: 'manual'|'sweep'|'budget'|'admin_policy'`) | `reason` |
| `campaign.viewed` | Consumer opens campaign detail (client-side, sampled) | surface (`home`, `business_page`, `qr`) |
| `campaign.qr_scanned` | §8 resolution | `qr_id`, `short_code` |
| `campaign.budget_exhausted` | §5 exhaustion | which cap, totals at exhaustion |
| `campaign.points_awarded` | Emitted by `35-points-engine.md` with campaign attribution per applied rule | `points`, `rule_id` |
| `campaign.reward_claimed` / `campaign.reward_redeemed` | Emitted by `35` claim/redemption flows with `campaign_id` of the reward | `reward_id`, `points_spent` |

Campaign performance dashboards (impressions → scans → claims → redemptions → points cost) are pure rollups of these events plus ledger/claims queries — the engine stores no aggregate columns.

## Schema deltas proposed

Ratified into `../20-data/26-schema-amendments.md`.

1. None required for the engine itself — lifecycle, scheduling, targeting, budget, and stacking operate entirely on existing columns; budget consumption totals are intentionally *derived* (ledger/claims sums), consistent with `../20-data/20-data-model.md` "balances are derived". Redis itself is real infrastructure in this project (`src/lib/redis.ts`: rate limiting, geocoding, QR scan counters, and the live-eligibility keys §2/§3 already reference) — what was never built is a cache key for THIS specific total. As of task 1.2, `max_total_points`/`per_customer_limit` are read fresh via a SQL aggregate (`private.campaign_points_awarded`/`private.campaign_customer_earn_count`) on every check, not cached; adding a Redis key here (re-derived on miss, per the original intent this line described) remains an open, undone optimization, not a shipped one.
2. `promotion_redemptions` table (promotion-family counter redemption tracking) — **DEFERRED [SCALE]**: adds counter friction for near-zero pilot value; G4 warns when unenforceable budget keys are set on promotion-family campaigns (26 decision summary).
