# 35 — Points Engine

Storage contract: `../20-data/23-schema-campaigns.md` (`points_rules`, `points_transactions`, `rewards`, `reward_claims`, `redemptions`, `loyalty_programs`, `loyalty_cards`) and `../20-data/21-schema-identity.md` (`business_customers`, `consumers`). Campaign liveness/stacking: `34-campaign-engine.md`. Receipt approval upstream: `36-receipt-ocr-pipeline.md`. Jobs: `39-background-jobs.md`.

## 1. Principles

1. **Append-only ledger.** `points_transactions` is INSERT-only (revoked UPDATE/DELETE grants + raising trigger). Corrections are compensating entries (`reversal`, `clawback`, `adjust`), never edits.
2. **Balances are derived.** `business_customers.points_balance` is a transactionally-maintained cache of `sum(points)`; it is re-derivable at any time and audited by integrity jobs (§12).
3. **One earn per receipt**, DB-enforced by the partial unique index `pt_receipt_earn_once` (`unique (receipt_id) where type='earn'`). Retried jobs and races cannot double-award.
4. **Integer points only** (`points integer`, product rule per `../20-data/20-data-model.md`). All fractional intermediate math is resolved by explicit per-rule `rounding` before anything is written.
5. **Balance never negative**: `balance_after >= 0` check + serialization (§5) + clamping policy for clawbacks (§9).
6. **Every write is explainable**: earn rows freeze the applied rules in `rule_snapshot`; manual ops require `adjust_reason` and `actor_id`; everything mirrors into `audit_logs`.

## 2. Rule model (`points_rules`)

Three `kind`s: exactly one active `base` rule per business (partial unique index `points_rules_one_base`); any number of `multiplier`/`bonus` rules layered on top, each usually attached to a campaign (`campaign_id`; null = business-default rule).

| `rule_type` | Math (inputs from `receipts`) | Columns used | Phase |
|---|---|---|---|
| `amount_rate` | `points = rounding(total_centavos / rate_centavos_per_point)` | `rate_centavos_per_point` (100 ⇒ ₱1 = 1 pt; 500 ⇒ ₱100 = 20 pts) | [MVP] |
| `fixed_per_visit` | `fixed_points` once per visit-day (first approved receipt of the consumer's day, Asia/Manila) | `fixed_points` | [MVP] |
| `fixed_per_receipt` | `fixed_points` per approved receipt | `fixed_points` | [MVP] |
| `tiered_amount` | Points of the tier containing `total_centavos` | `tiers` JSONB `[{min_centavos, max_centavos, points}]`, contiguous, non-overlapping, last `max_centavos` null = open-ended | [MVP] |

`multiplier` rules carry `multiplier numeric(4,2)` (e.g. 2.00) and `bonus` rules carry `bonus_points`; both use `conditions` to scope when they apply. Base rules may also carry `conditions` (rarely; e.g. `min_amount_centavos` earning floor).

### Conditions JSONB DSL

Evaluated at **`receipts.receipt_date`** in the campaign's `timezone` (default `Asia/Manila`) — never at processing time. All present keys AND together; `{}` = always applies (when the owning campaign is live).

```ts
// src/features/points/schemas.ts — validated on rule create/update
export const ruleConditionsSchema = z.object({
  days:                z.array(z.number().int().min(1).max(7)).nonempty().optional(), // ISO: 1=Mon … 7=Sun (matches businesses.opening_hours)
  time_from:           z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),      // wall clock, inclusive
  time_to:             z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),      // exclusive; from>to spans midnight
  birthday:            z.boolean().optional(),           // receipt_date month == profiles.birth_date month [V1]
  min_amount_centavos: z.number().int().positive().optional(),  // total_centavos >=
  first_visit:         z.boolean().optional(),           // business_customers.visit_count == 0 before this receipt
  // referral campaigns only (kind='bonus', type='referral') [V1] — §10:
  referrer_points:     z.number().int().positive().optional(),
  referee_points:      z.number().int().positive().optional(),
}).strict()
  .refine(c => (c.time_from === undefined) === (c.time_to === undefined),
          'time_from and time_to must be set together');
```

Validation rules on save: `days`/time windows only meaningful on `multiplier`/`bonus`/base rules (all allowed); `birthday`, `first_visit`, time windows are [V1] earning features (`../00-product/02-roadmap.md`) — the portal blocks them at MVP behind a feature flag; `referrer_points`/`referee_points` are required (both) when and only when the owning campaign has `type='referral'`. Unknown keys are rejected (`.strict()`) so the DSL can grow without silent misconfiguration.

## 3. Award pipeline (triggered by receipt approval)

Entry point: `36-receipt-ocr-pipeline.md` sets `receipts.status='approved'` (auto or human review) and emits `receipt.approved` → the points service runs synchronously in the same worker:

```
1  acquire per-pair lock (§5); begin tx
2  guard: receipt approved, business active, consumer not blacklisted (segment check),
         no existing earn for receipt (cheap pre-check; index is the real guard)
3  load active rules for business_id; load campaigns referenced by them
4  BASE   = compute per base rule_type (§2) on receipts.total_centavos
5  CANDS  = multiplier/bonus rules where owning campaign isCampaignLive(receipt_date)   ← 34 §3
            AND conditions match (§2 DSL, at receipt_date)
            AND campaign audience matches consumer (34 §4)
            AND campaign budget not exhausted (34 §5, max_total_points / per_customer_limit)
6  APPLIED = stacking resolution over CANDS                                             ← 34 §6
7  TOTAL  = base + Σ multiplier extras + Σ bonuses (per-rule rounding, below)
8  select … for update on business_customers (upsert row if first interaction)
9  insert points_transactions (type='earn', points=TOTAL, balance_after=prev+TOTAL,
         receipt_id, campaign_id = primary applied campaign or null, rule_snapshot, expires_at)
10 update business_customers: points_balance += TOTAL, lifetime_points += TOTAL,
         lifetime_spend_centavos += total_centavos, visit_count/visit timestamps (visit-day logic),
         first_visit_at coalesce, last_visit_at = receipt_date        ← same transaction, always
11 update loyalty_cards progress + handle completion (§ below)
12 commit; release lock; enqueue notify.push kind='points_awarded'; emit campaign.points_awarded events
```

**Arithmetic (exact):** `base_points = round_base(raw_base)` using the base rule's `rounding` (`floor`|`round`|`ceil`; `round` = half-up). Each applied multiplier contributes `extra_i = round_i(base_points × (multiplier_i − 1))` with that rule's `rounding` (stacked multipliers per `34` §6 additive-extras model). Each applied bonus contributes `bonus_points` verbatim. Everything is integer after rounding; `TOTAL ≥ 0` always (multipliers ≥ 0.01, bonuses > 0 by DB checks).

**`expires_at` on the earn row** = `receipt_date + expires_after_days` from the base rule's expiry setting (see "Schema deltas proposed"); null = never expires. Set from MVP; enforcement job is [V1] (`../00-product/02-roadmap.md`).

### Worked example

₱485.00 receipt (`total_centavos = 48500`), `receipt_date` Friday 2026-07-24 12:40 Asia/Manila. Base rule: `amount_rate`, `rate_centavos_per_point=100`, `rounding='floor'`. Live candidate: "Friday Double" campaign (priority 50, `is_stackable=false`) with multiplier rule `2.00`, `conditions={"days":[5]}`.

- Base: `floor(48500 / 100) = 485`.
- Friday matches (ISO day 5), campaign live at receipt_date → candidate; sorted first, non-stackable → applies alone.
- Extra: `floor(485 × (2.00 − 1)) = 485`. **TOTAL = 970**.
- Ledger row: `type='earn'`, `points=970`, `balance_after = 0 + 970 = 970`, `receipt_id` set, `campaign_id` = Friday campaign, `expires_at = 2027-07-24T04:40:00Z` (365-day expiry).

### `rule_snapshot` frozen shape (documented contract — analytics and support read this)

```jsonc
{
  "engine": "points/v1",                       // bump on algorithm changes
  "computed_at": "2026-07-24T05:31:02Z",
  "receipt": { "id": "0198…", "total_centavos": 48500, "receipt_date": "2026-07-24T04:40:00Z" },
  "base": { "rule_id": "0197…", "rule_type": "amount_rate",
            "rate_centavos_per_point": 100, "rounding": "floor", "points": 485 },
  "multipliers": [ { "rule_id": "0197…", "campaign_id": "0197…", "multiplier": "2.00",
                     "priority": 50, "is_stackable": false, "rounding": "floor", "points_delta": 485 } ],
  "bonuses": [],                               // [{rule_id, campaign_id, bonus_points}]
  "skipped": [ { "campaign_id": "0197…", "reason": "budget_exhausted" } ],   // optional, for support
  "total_points": 970
}
```

Snapshots for other types: `adjust` stores `{actor_role, cap_state}`; `referral_bonus` stores `{side:"referrer"|"referee", referee_id/referrer_id, receipt_id}`; `expire` stores the §7 computation inputs. The snapshot is documentation, never re-executed.

### Loyalty card update (step 11)

For each live `loyalty`/`membership` campaign's `loyalty_programs`: qualifying if `total_centavos ≥ min_amount_per_stamp_centavos` (when set) and stamps today (Asia/Manila, by `last_stamp_at`) `< max_stamps_per_day`. Progress increment by `program_type`: `visit_count`/`receipt_count` +1; `points_target` += TOTAL; `spend_amount` += `floor(total_centavos/100)` (pesos, matching `target_value` unit). On `progress ≥ target_value`: create `reward_claims` for `loyalty_programs.reward_id` (`claim_kind='loyalty_completion'`, `points_spent=0`, expiry per reward's `claim_expiry_days`), `completed_count += 1`, and if `resets_on_completion` then `progress -= target_value` (carryover kept), else progress freezes at target.

## 4. Rounding reference

`points_rules.rounding` applies per contribution (base, each multiplier extra), never to the running total: `floor` (default — house always rounds down), `round` (half-up: 0.5 → 1), `ceil` (promotional generosity). Examples for `raw = 484.5`: floor→484, round→485, ceil→485. Bonuses are integers by construction and are never rounded.

## 5. Concurrency & idempotency

- **Per-pair Redis lock**: `SET {env}:points:lock:{business_id}:{consumer_id} {job_id} NX PX 10000`; retry 3× with 100–300ms jitter; on failure the QStash job retries (worker idempotency per `39-background-jobs.md`). Release by compare-and-delete on the holder token.
- **Row lock**: inside the transaction, `select … for update` on the `business_customers` row (created via upsert first if absent). The Redis lock reduces contention; the row lock is the correctness guarantee — `balance_after` is computed under it, so ledger order per pair is strictly serialized.
- **Idempotency**: earns — `pt_receipt_earn_once` unique index makes replays a no-op (insert conflict → job succeeds silently). Claims/redemptions/adjustments — `Idempotency-Key` header per `../10-architecture/13-api-standards.md` plus natural keys (`redemptions.claim_id` unique, `token_jti` unique).

## 6. Redemption flow (rewards)

**Claim** (`POST /rewards/{rewardId}/claims`, consumer; flow detail in `33-consumer-pwa.md`):

1. Lock pair (§5); begin tx. Guards: reward `is_active`, its campaign live-claimable (`active`, within window), consumer not `blacklisted`, per-customer limits (reward's `per_customer_limit` and campaign `budget.per_customer_limit` — stricter wins), campaign `budget.max_redemptions` not exhausted (`34` §5).
2. Inventory: `update rewards set remaining = remaining - 1 where id=$1 and (remaining is null or remaining > 0) returning remaining` — zero rows updated ⇒ `409 REWARD_OUT_OF_STOCK`.
3. Balance: current `points_balance ≥ points_cost` else `422 POINTS_INSUFFICIENT`.
4. Insert `points_transactions` `type='redeem'`, `points = -points_cost` (skip when `points_cost=0`), `claim_id` set after claim insert (two inserts, same tx), `balance_after = prev − points_cost`.
5. Insert `reward_claims` (`status='claimed'`, `points_spent=points_cost`, `points_txn_id` → the redeem row, `expires_at = now() + claim_expiry_days`).
6. Update `business_customers.points_balance`; commit; notify `kind='reward_claimed'`.

**Redeem at counter** (`POST /redemptions/validate`, staff; flow F2 in `../10-architecture/10-system-architecture.md`): verify one-time token (TTL 5 min, Redis lock on `jti`); guards claim `status='claimed'` and `expires_at` future (`422 CLAIM_EXPIRED`), consumer not blacklisted; insert `redemptions` (`claim_id` unique ⇒ double-scan yields `409 CLAIM_ALREADY_REDEEMED`), set claim `status='redeemed'`, `redeemed_at`; Realtime confirm both screens. No ledger entry — points moved at claim time.

**Claim expiry sweep** (queue `claims.expiry_sweep`, hourly, driven by `reward_claims_expiry_idx`): for each `status='claimed'` with `expires_at <= now()` — set `status='expired'`; insert `points_transactions` `type='reversal'`, `points = +points_spent`, `reverses_id = points_txn_id`, `claim_id` set; restore balance; increment `rewards.remaining` (if tracked, capped by `rewards_remaining_lte_total`); notify `kind='reward_claim_expired'` [V1].

**Consumer cancel** (`public.cancel_claim(p_claim_id)`, RPC-only — no REST route, called directly from the server action; doc 13 line 3 puts Server Actions under "the same validation, authz, and error-shape rules minus the HTTP envelope", which is the posture the sweep above already has): the consumer's own way to reverse a `status='claimed'` row on demand instead of waiting for the sweep — task 1.4, closing doc `00-product/03-loyalty-benchmarks.md` Key Finding 1 ("points debited on intent and never returned"). Locks the claim row FOR UPDATE first (same position `validate_redemption` locks it, so the two cannot both win a race on the same claim); guards ownership (`consumer_id = auth.uid()`, else `403 FORBIDDEN` — doc 13: shared with "claim not found", never distinguished) and status (`409 CLAIM_ALREADY_REDEEMED` if a redemption already won the race, `409 CLAIM_ALREADY_CANCELLED` if already cancelled — idempotent, no double reversal — `422 CLAIM_INVALID_STATE` for any other non-`claimed` status, i.e. already `expired`). On success: identical reversal to the sweep above (same `type='reversal'` shape, restored balance, restored inventory) via the shared `private.reverse_claim_ledger` helper both this RPC and the sweep call, plus `reward_claims.status='cancelled'`, `cancelled_reason='consumer_cancelled'`. `validate_redemption` (the counter-side half of this same race) gained a matching `CLAIM_ALREADY_CANCELLED` branch in the same migration, so a staff scan that loses to a prior cancel names the reason instead of falling into the generic `CLAIM_INVALID_STATE` catch-all.

Known, accepted consequence: `per_customer_limit` and `budget.max_redemptions` above both count non-cancelled claims only (0013, predating this RPC), so a consumer can claim → cancel → claim the same reward without bound. No attacker gain (nothing is minted; each cycle is a real debit and a real, immediate refund) and no cross-tenant impact, but it removes a cap that existed before cancellation had a writer and produces two extra append-only ledger rows per cycle on the consumer's own statement. Not bounded in task 1.4; a future task owns deciding whether/how to rate-limit it if it proves to matter in practice.

**Worked example:** balance 970. Claim "Free Milk Tea" (`points_cost=500`, `remaining` 50→49, `claim_expiry_days=30`): redeem txn `-500`, `balance_after=470`. (a) Staff validates day 3 → `redemptions` row, claim `redeemed`; final balance 470. (b) Never shown: day 30 sweep → claim `expired`, reversal txn `+500`, `balance_after=970`, `remaining` 49→50.

## 7. Points expiry

Enforced as of task 1.3 (`supabase/migrations/0042`-`0046`): `award_receipt_points` stamps `expires_at` on every positive earn row, `public.expire_points` (daily, 02:10 Manila) sweeps the FIFO remainder below, `public.points_expiry_warn` (daily, 02:25 Manila) raises `kind='points_expiring'` at the 30d/7d horizons, and the wallet's `public.points_next_expiry` reads the identical formula. See `supabase/README.md`'s "Points expiry" section for the shipped shape and its known limitations (the warn job's `email` channel is written but not yet delivered).

Earn rows carry `expires_at` (set from MVP, §3). Consumption is **implicit FIFO — bookkeeping by arithmetic, not per-row allocation**. No consumption links are stored; the sweep derives the expirable remainder from ledger sums. This is correct because expiry order equals creation order: all positive rows in a pair share one TTL policy at write time, so `expires_at` is monotone in `created_at` (rows with null `expires_at` sort as +∞ and never expire; the policy-change caveat is in "Schema deltas proposed").

**Definitions for a (business, consumer) pair at sweep time `t`:**

- `X(t)` = `sum(points)` of positive rows (`earn`, `referral_bonus`, positive `adjust`) with `expires_at <= t` — everything that has ever hit its expiry date.
- `D(t)` = `−sum(points)` of all negative rows (`redeem`, negative `adjust`, `expire`, `clawback`; `reversal` rows are positive and never counted here) — everything ever drained, by FIFO consuming oldest-first.
- **Expirable remainder** `= max(0, X(t) − D(t))`, additionally clamped to current `points_balance` (equal by invariant; the clamp is defense-in-depth for drift).

Prior `expire` rows are inside `D(t)`, so each sweep only expires what previous sweeps and spends have not already drained — the formula is stable under repeated runs and needs no state beyond the ledger itself.

**Sweep job** (queue `points.expiry_sweep`, daily 02:10 Asia/Manila per the `39-background-jobs.md` schedule, driven by `pt_expiry_idx`): select distinct pairs having earn rows with `expires_at <= now()` not yet fully drained (cheap pre-filter: pair appears in `pt_expiry_idx` and `points_balance > 0`); per pair under the §5 locks: compute remainder; if > 0 insert `points_transactions` `type='expire'`, `points = −remainder`, `rule_snapshot = {engine:"points/v1", x_expired_sum, d_drained_sum, remainder, cutoff}`; update `points_balance`; notify `kind='points_expired'`. Chunked 200 pairs/job.

**Expiry warnings [V1]** (queue `points.expiry_warn`, daily): same formula with `t = now() + 30d` and `+ 7d`; positive projected remainder → notification `kind='points_expiring'` (`{points, expires_on}`), deduped per pair per horizon via `jobs.dedupe_key`.

## 8. Manual adjustments

`type='adjust'`, positive or negative, via `POST /businesses/{businessId}/customers/{consumerId}/points-adjustments` (idempotent). Rules:

- `adjust_reason` required (service-enforced; DB column `adjust_reason`) — `422 VALIDATION_FAILED` without it. `actor_id` = acting staff profile.
- **Caps per permission matrix** (`../00-product/01-personas-roles.md` note 5): `manager` limited to ±500 points/day/customer (configurable platform setting); `owner` uncapped within tenant; `super_admin` uncapped (audited, reason required). Cap accounting = same-day (`Asia/Manila`) sum of |points| of `adjust` rows by that actor for that consumer — checked in-transaction; breach → `422 POINTS_ADJUST_CAP_EXCEEDED`.
- Negative adjustments clamp to balance (never below 0); positive adjustments get `expires_at` per the business expiry policy.
- Audit: `audit_logs` `action='points.adjusted'` with before/after balance and reason; adjustments surface in the consumer's statement labeled by the business.

## 9. Clawbacks & reversals

**Fraud clawback [V1]** (`37-fraud-detection.md` verdict on an already-awarded receipt): insert `type='clawback'`, `reverses_id` → the original earn row, `points = −min(original_earn_points, current_balance)` — **clamped; the ledger never drives a balance negative** (`balance_after >= 0` is a DB check). Residual-debt policy: the shortfall (`original − clawed`) is **not** carried as negative balance; it is recorded in the audit trail (`audit_logs` `action='points.clawback'`, `after.shortfall_points`) and in the fraud case evidence, and the consumer's standing (repeat shortfalls ⇒ `blacklisted` segment recommendation) handles the rest. Also unwinds loyalty progress attributable to the receipt (floor at 0) and emits `campaign.points_awarded` negative attribution for analytics.

**Receipt reversal** (post-approval rejection without fraud verdict — e.g. human review overturn, wrong business match): same mechanics with `type='reversal'`, `reverses_id` → the earn row, clamped identically; receipt gets `reject_reason`/`reject_note` per `../20-data/24-schema-receipts-ai.md`; consumer notified `kind='receipt_rejected'`.

Both are subject to the §5 locks and are idempotent: at most one `clawback`/`reversal` per `reverses_id` (service check inside the pair lock — see "Schema deltas proposed" for the optional index).

## 10. Referral bonuses [V1]

Configured as a `referral` campaign whose `points_rules` row is `kind='bonus'` with `conditions.referrer_points` / `conditions.referee_points` (`34` §7). Trigger: the **referee's first approved receipt** (any business? No — the referral campaign is tenant-scoped, so: referee's first approved receipt *at that business*), detected in the award pipeline (`first_visit` semantics) when `consumers.referred_by` is set.

- Two ledger rows in the same transaction: referee `type='referral_bonus'`, `points = referee_points`, `receipt_id` = triggering receipt; referrer `type='referral_bonus'`, `points = referrer_points`, same `receipt_id`, `campaign_id` set on both. Both respect campaign `budget.max_total_points` (both sides count) and `per_customer_limit` (applied to the **referrer** — caps how many referrals one person is paid for).
- **Self-referral guards**: `referred_by` is set once at signup from a `referral_code` and immutable; code ≠ own code enforced at signup; referrer and referee must be distinct `consumers.id`; device overlap (`user_devices` shared `fcm_token`/fingerprint) flags the pair to fraud review instead of granting (`37-fraud-detection.md`); grants dedup on `(consumer_id, receipt_id) where type='referral_bonus'` (see deltas) — one grant per side, ever, since only one "first receipt" exists.

## 11. Points preview (shared pure function)

Per `../10-architecture/14-development-standards.md` ("no duplicated business logic"), the entire §3 computation (base + candidates + stacking + rounding) is one pure function:

```ts
// src/features/points/lib/compute.ts — no I/O, fully unit-tested (TDD per 02-roadmap build order)
export function computePoints(input: {
  totalCentavos: number; receiptDate: Date;
  baseRule: PointsRule; candidateRules: RuleWithCampaign[];
  customer: { visitCount: number; segment: Segment; birthMonth?: number };
}): { total: number; snapshot: RuleSnapshot }
```

The server award pipeline calls it with DB-loaded rules; the consumer PWA scanner screen calls the same function (rules fetched via the public campaign endpoint) to show "you'll earn ~970 pts" instantly while OCR settles. The optimistic preview is labeled *pending* — the ledger row is the only truth. The portal rule editor uses it for "test a receipt" previews (`POST /businesses/{businessId}/points-rules/preview` runs it server-side for parity checks in CI).

## 12. API surface

Conventions per `../10-architecture/13-api-standards.md`; consumer wallet UX in `33-consumer-pwa.md`, portal screens in `32-business-portal.md`.

| Method & path | Purpose | Roles | Notable errors |
|---|---|---|---|
| `GET /me/points` | Balances across businesses (from `business_customers`) | consumer | — |
| `GET /me/points/transactions?business_id=&cursor=` | Statement (ledger, newest first) | consumer | — |
| `GET /me/rewards?status=&cursor=` | Claims wallet | consumer | — |
| `POST /rewards/{rewardId}/claims` (idempotent) | Claim a reward (§6) | consumer | `POINTS_INSUFFICIENT`, `REWARD_OUT_OF_STOCK`, `REWARD_EXPIRED`, `CAMPAIGN_LIMIT_REACHED`, `CUSTOMER_BLACKLISTED`, `CAMPAIGN_BUDGET_EXHAUSTED` |
| `POST /reward-claims/{claimId}/token` | Mint one-time redemption token (QR payload) | consumer (claim owner) | `CLAIM_EXPIRED`, `CLAIM_ALREADY_REDEEMED` |
| `POST /redemptions/validate` (idempotent) | Staff counter validation (§6) | owner, manager, staff [V1] | `REDEMPTION_TOKEN_INVALID`, `CLAIM_ALREADY_REDEEMED`, `CLAIM_EXPIRED`, `CUSTOMER_BLACKLISTED` |
| `GET/POST/PATCH /businesses/{businessId}/points-rules` | Rule CRUD (base/multiplier/bonus) | owner, manager | `VALIDATION_FAILED`, `POINTS_BASE_RULE_EXISTS` |
| `POST /businesses/{businessId}/points-rules/preview` | Run `computePoints` on a hypothetical receipt | owner, manager, marketing | — |
| `POST /businesses/{businessId}/customers/{consumerId}/points-adjustments` (idempotent) | Manual adjust (§8) | owner, manager (capped), super_admin | `POINTS_ADJUST_CAP_EXCEEDED`, `VALIDATION_FAILED` |
| `GET /businesses/{businessId}/customers/{consumerId}/points` | CRM view: balance + statement | owner, manager, marketing | `NOT_FOUND` |

`public.cancel_claim` (task 1.4, §6) deliberately gets no row in the table above: like the claim expiry sweep, it is RPC-only with no REST route — the consumer app calls it through a server action, not an API endpoint. Its error codes (`FORBIDDEN`, `CLAIM_ALREADY_REDEEMED`, `CLAIM_ALREADY_CANCELLED`, `CLAIM_INVALID_STATE`) still belong in the transport-agnostic registry below, the same way `CLAIM_ALREADY_REDEEMED` already does for the equally RPC-only `validate_redemption`.

### Domain error codes registered (extends `../10-architecture/13-api-standards.md` registry)

| HTTP | Code | Meaning |
|---|---|---|
| 422 | `POINTS_INSUFFICIENT` | Balance < `points_cost` (already in shared registry; owned here) |
| 422 | `POINTS_ADJUST_CAP_EXCEEDED` | Manager daily ±500/customer cap breached |
| 409 | `POINTS_BASE_RULE_EXISTS` | Second active base rule attempted (mirrors `points_rules_one_base`) |
| 409 | `REWARD_OUT_OF_STOCK` | Conditional inventory decrement matched zero rows (409 `CONFLICT` family per `../10-architecture/13-api-standards.md`) |
| 422 | `REWARD_EXPIRED` | Reward/campaign no longer claimable (shared registry; owned here) |
| 422 | `CLAIM_EXPIRED` | Claim past `expires_at` |
| 409 | `CLAIM_ALREADY_REDEEMED` | `redemptions.claim_id` uniqueness hit / claim not in `claimed` |
| 409 | `CLAIM_ALREADY_CANCELLED` | `cancel_claim` or `validate_redemption` hit a claim already `status='cancelled'` (task 1.4) |
| 422 | `REDEMPTION_TOKEN_INVALID` | Token expired, replayed (`jti` consumed), or malformed (shared registry) |
| 403 | `CUSTOMER_BLACKLISTED` | `business_customers.segment='blacklisted'` blocks earn/claim/redeem |

(`CAMPAIGN_LIMIT_REACHED`, `CAMPAIGN_BUDGET_EXHAUSTED` registered in `34-campaign-engine.md`.)

## 13. Integrity jobs

Per `../20-data/20-data-model.md` ("balances are derived, ledger is truth") and `../50-ops/52-monitoring-observability.md`:

| Job (queue) | Cadence | What it does |
|---|---|---|
| `integrity.balance_check` (`mode:'sample'`) | Nightly | Re-derive `points_balance` for a 1% random sample of `business_customers` (plus every pair touched by clawback/expire in the last 24h) via `sum(points_transactions.points)`; compare; also spot-check newest rows' `balance_after` chain continuity |
| `integrity.balance_check` (`mode:'full'`) | Weekly | Full re-derivation, chunked by `business_id`; also re-derives `rewards.remaining` (initial inventory − claimed + expired/cancelled restores), `loyalty_cards.progress`, `consumers.lifetime_points_earned`, `business_customers.lifetime_points` |
| Drift handling | — | Any mismatch → Sentry alert (severity: error) with pair ids and delta; **no auto-correction** — runbook investigates (drift means a code path skipped the transactional update), then a system `adjust` with reason `integrity_correction` reconciles, keeping the ledger the explanation of record |

Alert SLO: zero drift expected; a single drifted pair is an incident, not noise.

## 14. Test checklist (minimum, per `../50-ops/51-testing-strategy.md`)

- `computePoints` unit matrix: every `rule_type` × every `rounding` × stacking scenarios from `34` §6 (golden cases include the §3 worked example: 48500¢ / rate 100 / Friday 2.00× → 970).
- Condition DSL: day boundaries at midnight Asia/Manila, midnight-spanning windows (`22:00→02:00`), `birthday` month edges, `first_visit` on the very first receipt, receipt_date-vs-processing-date divergence (Friday receipt processed Saturday still gets the Friday multiplier).
- Concurrency: two simultaneous awards for one pair produce sequential `balance_after`; duplicate `receipt.approved` deliveries produce exactly one earn row (`pt_receipt_earn_once`).
- Redemption: out-of-stock race (two claims, one unit), double token scan, claim-expiry sweep restores points and inventory exactly once.
- Expiry: §7 formula property test — for random ledgers, `expire` rows never exceed balance and repeated sweeps are idempotent.
- Clawback clamping: balance 100, clawback of 970-point earn → clawback row is −100, shortfall 870 in audit `after`, balance 0.
- RLS (pgTAP matrix): consumer reads only own ledger rows; staff only own tenant; no role can UPDATE/DELETE `points_transactions`.

## Schema deltas proposed

Ratified into `../20-data/26-schema-amendments.md`.

1. `points_rules.expires_after_days` (expiry policy on the base rule) — **ACCEPTED** [MVP] (A23.1).
2. Partial unique index `pt_referral_once` — **ACCEPTED** [V1] (A23.2).
3. Partial unique index `pt_reverses_once` — **ACCEPTED** [V1] (A23.3).
