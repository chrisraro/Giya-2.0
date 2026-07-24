# 37 — Fraud Detection

Threat #1 in the threat model (`../10-architecture/15-security.md`): points/reward fraud — fake, altered, borrowed, replayed receipts; self-dealing staff. This module is the fraud stage of the receipt pipeline (`36-receipt-ocr-pipeline.md`, gate before Stage 9 routing) plus the cross-receipt/ring analytics, review queues, consequence machinery, and monitoring. Storage: `fraud_signals` in `../20-data/24-schema-receipts-ai.md`. Everything `[MVP]` unless tagged.

## Philosophy

**Layered signals → composite score → route.**

- Each detector is small, independent, explainable, and writes a `fraud_signals` row (`signal`, `severity`, `score`, `evidence` JSONB) when tripped — **including on receipts that end up approved**. Scoring history is how thresholds get tuned and slow-burn abusers get caught.
- Per golden rule 5 (`../README.md`): **AI never final-decides.** The only automatic rejections are *deterministic* facts — byte-identical image, live duplicate receipt number, near-identical perceptual hash. Everything probabilistic routes to human review.
- Signals are cheap. False `info`/`warn` rows cost nothing; missing evidence costs trust.
- Thresholds are data, not code: defaults live in `settings` rows `scope='platform'` (`../20-data/25-schema-platform.md`), tunable without deploy. Registry at the bottom of this doc.

Signal vocabulary is the `fraud_signal_type` enum (`../20-data/20-data-model.md`):
`image_hash_dup` · `ocr_similarity_dup` · `receipt_number_dup` · `velocity` · `timestamp_anomaly` · `gps_mismatch` · `amount_anomaly` · `ai_confidence_low`.

Execution point: OCR worker, after field extraction and validity checks (`36` Stage 8), before outcome routing (Stage 9). Detectors run in one pass; rows insert in one batch with `business_id` and `consumer_id` denormalized (fast per-consumer history via `fraud_signals_consumer_idx`).

## Signal catalog

### S1 `image_hash_dup` — duplicate / replayed image

Two layers:

1. **Exact bytes — hard DB reject.** `receipts_sha_unique` on `receipts.sha256` aborts the insert at submission time → synchronous `422 RECEIPT_DUPLICATE` (`36` Stage 1). Never reaches the pipeline; no signal row. This is the single sanctioned auto-block without review.
2. **Perceptual.** Hamming distance between the new `receipts.image_hash` (64-bit DCT pHash, `36` Stage 1) and prior hashes. Candidate set `[MVP]`: same consumer (all time) + same business last 90 days (`receipts_hash_idx`, `receipts_biz_status_idx`); platform-wide cross-consumer widening `[V1]`. Comparison in-worker: hex → int64, XOR + popcount — candidate sets are small enough that no BK-tree is needed until `[SCALE]`.

| Hamming distance | Interpretation | Severity / score | Routing effect |
|---|---|---|---|
| 0–4 | Same photo re-encoded, cropped, filtered | `block` / 1.0 | `rejected / duplicate` |
| 5–10 | Same physical receipt re-photographed | `warn` / 0.6 | weighted into composite |
| >10 | Different document | no signal | — |

`evidence`: `{"matched_receipt_id": "…", "hamming_distance": 3, "matched_consumer_id": "…"}`.
A 0–4 match where `matched_consumer_id <> consumer_id` is simultaneously ring evidence (S-ring below).

### S2 `ocr_similarity_dup` — same text, different photo `[V1]` (roadmap Fraud v2)

Catches what pHash misses: the same receipt re-shot under new lighting/angle, or a reprinted/re-typed copy.

- Input: normalized `ocr_results.raw_text` (uppercase, collapse whitespace; digits and date tokens preserved — they carry document identity).
- Candidates (30-day window): same consumer+business `[V1]`; same business cross-consumer `[V1]`.
- Method: `pg_trgm` `similarity()` with a GIN trigram index on `ocr_results.raw_text` (schema delta below); MinHash-LSH prefilter in the worker when a business's candidate set exceeds ~500.
- Thresholds: `similarity >= 0.92` → `warn` / 0.7; `>= 0.85` → `info` / 0.3.
- **Never block on text alone.** Two honest receipts from the same POS on the same day differ only in number/time/amount. The composite does the work: text-sim + `receipt_number_dup` or equal `total_centavos` is what pushes past the review threshold.

`evidence`: `{"matched_receipt_id": "…", "similarity": 0.94, "matched_consumer_id": "…"}`.

### S3 `receipt_number_dup` — replayed receipt number

- DB backstop: `receipts_number_unique` — unique `(business_id, receipt_number)` where status ∈ `approved/review/processing` (`../20-data/24-schema-receipts-ai.md`). Two live claims of one number at one business cannot coexist; rejected rows are excluded so honest resubmission works.
- On conflict during parse-write: `rejected / duplicate` + signal `block` / 1.0.
- **Cross-consumer same-number = ring signal.** Two accounts claiming one physical receipt (receipt-passing at the counter, bin-diving). Same-consumer conflict is usually an accidental double-scan — the consumer-facing message says exactly that.
- Soft variant: number matches a prior `rejected` row → `info` / 0.2 (context only).

`evidence`: `{"matched_receipt_id": "…", "receipt_number": "004512", "matched_consumer_id": "…", "cross_consumer": true}`.

### S4 `velocity` — too much, too fast

Sliding-window counters in Upstash Redis (hot path), always recomputable from `receipts` — losing Redis loses speed, never truth (D4, `../10-architecture/10-system-architecture.md`). Defaults:

| Window | Cap | Severity / score | Settings key |
|---|---|---|---|
| Consumer / hour | 4 | `warn` / 0.5 | `fraud.velocity.consumer_hour` |
| Consumer / day | 10 | `warn` / 0.6 | `fraud.velocity.consumer_day` |
| Consumer × business / day | 3 | `warn` / 0.5 | `fraud.velocity.pair_day` |
| Consumer × business / 10 min | 2 | `warn` / 0.7 | `fraud.velocity.pair_10min` |
| Device (`receipts.device_id`) / day, across accounts | 12 | `warn` / 0.6 | `fraud.velocity.device_day` |

The API rate limit (6/min, 60/day, `../10-architecture/13-api-standards.md`) is a transport cap; these are behavioral caps that fire earlier and route to *review*, never block — batch-scanning a week of receipts after onboarding is legitimate and common.

`evidence`: `{"window": "pair_10min", "count": 3, "cap": 2}`.

### S5 `timestamp_anomaly` — impossible or implausible time

| Case | Check | Severity / score |
|---|---|---|
| Future-dated | `receipt_date > now() + 24h` (TZ grace) | `warn` / 0.7 |
| Outside opening hours | extracted time-of-day vs `businesses.opening_hours` JSONB (`../20-data/21-schema-identity.md`); skipped when hours unset or time not extracted | `warn` / 0.4 |
| Too old / predates activation | `36` Stage 8 already rejected (`too_old`, vs `businesses.verified_at`) | `info` / 0.1 (history row only) |

`evidence`: `{"kind": "closed_hours", "receipt_date": "…", "opening_hours_day": {"day": 2, "open": "08:00", "close": "22:00"}}`.

### S6 `gps_mismatch` `[V1]` — submitted far from the store

- **Opt-in only** (`consumers.gps_fraud_opt_in`; RA 10173 data minimization per `../10-architecture/15-security.md`). Absence of GPS is never a signal.
- When `receipts.submitted_lat/lng` present: Haversine distance to `businesses.lat/lng`.
- > 2km (`fraud.gps_warn_m`) → `warn` / 0.4; > 20km → `warn` / 0.6.
- **Warn, never block.** People scan at home; takeout exists; GPS drifts indoors.

`evidence`: `{"distance_m": 5231, "threshold_m": 2000}`.

### S7 `amount_anomaly` — implausible totals

| Pattern | Check | Severity / score |
|---|---|---|
| Outlier total | `total_centavos` > business trailing-90d p99 of approved totals (rollup cached daily; fallback: template `amount_sanity.max_total_centavos`, `36` parse_config) | `warn` / 0.5 |
| Round-number abuse | last ≥5 approved receipts for this consumer×business all `total_centavos % 10000 = 0` AND template `source_kind='handwritten'` — pad receipts invite invented totals | `warn` / 0.4 |
| Total ≠ Σ line items | beyond VAT tolerance (`36` Stage 7) | `info` / 0.2 |

`evidence`: `{"observed_centavos": 1500000, "p99_centavos": 480000}` / `{"pattern": "round_numbers", "streak": 6}`.

### S8 `ai_confidence_low` — the model itself is unsure

- `ocr_results.mean_confidence < 0.5` → `info` / 0.3.
- Any load-bearing field produced by LLM parse-assist (`36` Stage 7 tier 3) → `info` / 0.2.
- Never blocks; contextualizes review and already gates auto-approval via `parse_confidence` (`36` Stage 9).

`evidence`: `{"mean_confidence": 0.42}` / `{"llm_fields": ["total_centavos"]}`.

### S9 Staff self-scanning guard (anti-abuse of staff)

Self-dealing staff are threat-model item 1 (`../10-architecture/15-security.md`).

- Check: `receipts.user_id` ∈ active staff of `receipts.business_id` —
  ```sql
  select 1 from public.business_staff
   where business_id = $1 and user_id = $2 and status = 'active';
  ```
- Trip: `warn` / 0.8 and **unconditional route to `review`**, regardless of composite. The review service additionally rejects a decision where the reviewer is the submitter (`reviewed_by = receipts.user_id` → `403 FORBIDDEN`).
- Enum home: proposed value `staff_self_scan` (schema delta below). Until that migration lands, emitted as `velocity` with `evidence={"kind":"staff_self_scan"}` — explicitly flagged interim.
- Adjacent surface — **owner manual-points abuse**: `points_transactions` `type='adjust'` requires `adjust_reason` + `actor_id` (`../20-data/23-schema-campaigns.md`) and every adjustment lands in `audit_logs`. The admin fraud dashboard `[V1]` charts adjust volume per business and per actor, so owner self-crediting is visible even though it never passes through this pipeline.

## Scoring & routing

```
weight(block) = 1.0     weight(warn) = 0.4     weight(info) = 0.1
composite = min(1.0, Σ_i  score_i × weight(severity_i))
```

| Condition | Route |
|---|---|
| Any `block` signal | `rejected` — `reject_reason='duplicate'` for the dup family, else `'fraud_suspected'` |
| `composite >= 0.5` (`fraud.review_threshold`) | `review` — even if `parse_confidence` alone would auto-approve |
| Staff self-scan (S9) | `review`, unconditional |
| otherwise | pass → confidence routing in `36` Stage 9 |

Worked example: a receipt trips S4 pair_10min (`warn`, 0.7) and S7 round-numbers (`warn`, 0.4) → composite = 0.7×0.4 + 0.4×0.4 = 0.44 → **passes** fraud (below 0.5), then routes on parse confidence. Add S5 closed-hours (`warn`, 0.4 → +0.16) → 0.60 → **review**. Three weak signals together are exactly what should reach a human; any one alone should not.

Fraud evaluation always completes **before** any points award — there is no award-then-check path. The `earn` row is written only after routing lands on `approved` (`pt_receipt_earn_once` makes double-award impossible regardless, `../20-data/23-schema-campaigns.md`).

## Fraud rings `[V1]` (roadmap Fraud v2)

Nightly batch job (queue `fraud.ring_sweep`, `39-background-jobs.md`) + admin surfacing. Detection queries live in `src/features/fraud/queries/`; representative shapes:

**Cross-consumer duplicate clusters** — graph over dup-family evidence, 90-day window:

```sql
select fs.consumer_id, (fs.evidence->>'matched_consumer_id')::uuid as other_consumer,
       count(*) as links
  from public.fraud_signals fs
 where fs.signal in ('image_hash_dup','receipt_number_dup','ocr_similarity_dup')
   and fs.evidence->>'matched_consumer_id' is not null
   and (fs.evidence->>'matched_consumer_id')::uuid <> fs.consumer_id
   and fs.created_at > now() - interval '90 days'
 group by 1, 2 having count(*) >= 2;
-- worker unions edges into connected components; components of ≥3 accounts → ring case
```

**Shared devices** — distinct consumers per device per business:

```sql
select r.device_id, r.business_id,
       count(distinct r.user_id) as accounts, count(*) as receipts
  from public.receipts r
 where r.device_id is not null and r.created_at > now() - interval '30 days'
 group by 1, 2 having count(distinct r.user_id) > 2;
```

Family members legitimately share phones → surfaced as evidence, never auto-actioned.

**Referral abuse** — `consumers.referred_by` chains (`../20-data/21-schema-identity.md`):

- *Self-referral:* referee shares a `device_id` (via `receipts`/`user_devices`) with its referrer.
- *Referral farm:* referrer with > `fraud.referral_farm_min` referees (default 10) of which ≥80% have zero approved receipts 14 days after signup.
- Confirmed cases feed clawback of `points_transactions` `type='referral_bonus'` rows (`35-points-engine.md`).

Ring outputs are **cases** (grouped evidence) in the admin fraud queue — recorded under proposed signal values `device_shared` / `referral_abuse` (delta below) — never automatic punishment.

## Consequences ladder

Each step past the first requires a human decision; every step is audited.

| Step | Trigger | Mechanism | Actor |
|---|---|---|---|
| 1. Reject | Any single fraud rejection | `receipts.status='rejected'` + notification `kind='receipt_rejected'` | automatic |
| 2. Cooldown | 3 fraud-family rejections / 30 days (`fraud.cooldown_strikes`, counted from `fraud_signals_consumer_idx`) | 24h scan block (`fraud.cooldown_hours`): Redis key + proposed `consumers.scan_blocked_until`; submit → `403 CONSUMER_SCAN_BLOCKED` | automatic, auto-expiring, audited |
| 3. Business blacklist | Owner/manager judgment (queue evidence) | `business_customers.segment='blacklisted'` (`../20-data/21-schema-identity.md`): future receipts at that business force `review`; claims/redemptions refused (F2 standing check) | owner/manager |
| 4. Platform suspension | Cross-business abuse, rings | `profiles.is_suspended=true` + `suspended_reason`; full lockout | platform admin, reason mandatory (`../10-architecture/15-security.md`) |
| 5. Clawback | Post-approval fraud confirmation | `points_transactions` `type='clawback'`: negative points, `reverses_id` → original `earn` row, `receipt_id` provenance (`35-points-engine.md`); receipt → `rejected/fraud_suspected` with `reviewed_by` set | admin (or owner via review, `[V1]`) |

Clawback when the balance was already spent: the ledger entry still posts under the per-pair serialization (`balance_after >= 0` invariant, `../20-data/23-schema-campaigns.md`); any unrecoverable residual is written off and counted in the leak metric — never silently negative.

## Review queues

**Business queue** (`32-business-portal.md`): the tenant's `review` receipts — the same queue as `36`'s human review (`receipts_review_idx`, RLS P1). Fraud context renders as the signal list per item; staff read own-tenant `fraud_signals` per its RLS note (`../20-data/24-schema-receipts-ai.md`).

**Admin fraud queue** (`31-admin-portal.md`): platform-wide. Fed by `block`/`warn` signals, S9 items, business escalations, ring cases `[V1]`.

Evidence display contract per item:

- Signal rows with `severity`, `score`, and rendered `evidence` — side-by-side image comparison for dup matches (both receipts via 5-min signed URLs, `../10-architecture/15-security.md`), distance readout for GPS, count/cap bars for velocity.
- Linked receipts (`matched_receipt_id` chains) and the consumer's history summary: approval ratio, prior signals, strikes, devices.

Reviewer actions → audit mapping (every action inserts `audit_logs` with `actor_id`, `before/after`, mandatory `reason`, `request_id` — `../20-data/25-schema-platform.md`):

| Action | `audit_logs.action` |
|---|---|
| Approve receipt | `receipt.review_approved` |
| Reject receipt | `receipt.review_rejected` |
| Apply/lift cooldown | `fraud.cooldown_applied` / `fraud.cooldown_lifted` |
| Blacklist customer | `customer.segment_changed` |
| Suspend consumer | `consumer.suspended` |
| Clawback | `fraud.clawback_applied` |

## Monitoring & reporting

- **Fraud leak rate** = confirmed-fraudulent approved receipts (clawed back or admin-confirmed post-hoc) / all approved. Target **< 1% `[MVP]`** (roadmap exit criterion, `../00-product/02-roadmap.md`), tightening to **< 0.5% `[V1]`**.
- **Overturn rate**: fraud-routed `review` items approved by the reviewer. Sustained > 40% ⇒ thresholds too hot; feed back into `settings`.
- Alerting (`../50-ops/52-monitoring-observability.md`): `block`-signal rate > 3× trailing 7-day baseline (attack in progress); per-business fraud-score p50 spike (targeted abuse or a broken template mis-parsing everything); clawback volume alert; cooldown-application spike.
- **Weekly fraud report job** (queue `fraud.weekly_report`, scheduled per `39-background-jobs.md`): platform + per-business digest — signals by type/severity, leak estimate, overturn rate, top-flagged consumers, ring candidates `[V1]`, manual-adjust outliers (S9 note) — persisted for the admin dashboard and emailed (Resend) to platform admins.

## API surface

Per `../10-architecture/13-api-standards.md`. Receipt review endpoints are owned by `36-receipt-ocr-pipeline.md`; below are fraud-specific surfaces.

| Method & path | Auth | Notes |
|---|---|---|
| `GET /api/v1/businesses/{businessId}/receipts/{id}/fraud-signals` | owner/manager | Own-tenant signals for the review UI |
| `PATCH /api/v1/businesses/{businessId}/customers/{consumerId}` | owner/manager | `{segment: 'blacklisted'|'regular'|'vip'}`; audited |
| `GET /api/v1/admin/fraud/queue` | admin | Cursor; filters `severity`, `signal`, `business_id` |
| `GET /api/v1/admin/fraud/rings` `[V1]` | admin | Ring cases from the nightly sweep |
| `POST /api/v1/admin/receipts/{id}/clawback` | admin | `Idempotency-Key`; reason required |
| `POST /api/v1/admin/consumers/{id}/cooldown` | admin | Apply/lift; reason required |
| `POST /api/v1/admin/consumers/{id}/suspend` | admin | Sets `profiles.is_suspended`; reason required |
| `GET /api/v1/admin/fraud/report` | admin | Weekly report data |

Error codes registered by this module:

| Code | HTTP | When |
|---|---|---|
| `RECEIPT_DUPLICATE` | 422 | Deterministic duplicate (shared with 36) |
| `RECEIPT_FRAUD_SUSPECTED` | 422 | Receipt detail for `rejected / fraud_suspected` |
| `CONSUMER_SCAN_BLOCKED` | 403 | Submission during cooldown; `Retry-After` = cooldown end |
| `CUSTOMER_BLACKLISTED` | 403 | Claim/redemption by a blacklisted `business_customers` row (also cited by F2) |
| `CLAWBACK_INVALID_STATE` | 409 | No `earn` row for the receipt, or already reversed (`pt_receipt_earn_once` + `reverses_id` check) |

## Default settings registry (rows in `settings`, `scope='platform'`)

| Key | Default | Notes |
|---|---|---|
| `fraud.phash_block_distance` | 4 | S1 block band |
| `fraud.phash_warn_distance` | 10 | S1 warn band |
| `fraud.text_sim_warn` | 0.92 | S2 `[V1]` |
| `fraud.velocity.consumer_hour` / `consumer_day` | 4 / 10 | S4 |
| `fraud.velocity.pair_day` / `pair_10min` | 3 / 2 | S4; business-scope override allowed (`scope='business'`) |
| `fraud.velocity.device_day` | 12 | S4 |
| `fraud.review_threshold` | 0.5 | composite routing |
| `fraud.gps_warn_m` | 2000 | S6 `[V1]` |
| `fraud.cooldown_strikes` / `cooldown_hours` | 3 / 24 | ladder step 2 |
| `fraud.referral_farm_min` | 10 | rings `[V1]` |

## Schema deltas proposed

Ratified into `../20-data/26-schema-amendments.md`.

1. `fraud_signal_type` add `staff_self_scan` — **ACCEPTED** [MVP] (A24.3; interim `velocity` encoding retires with the migration).
2. `consumers.scan_blocked_until` — **ACCEPTED** [MVP] (A21.3).
3. Trigram index `ocr_results_rawtext_trgm` — **ACCEPTED** [V1] (A24.4).
4. `fraud_signal_type` add `referral_abuse` + `device_shared` — **ACCEPTED** [V1] (A24.3).
5. `fraud_cases` table — **DEFERRED**: evidence-JSONB grouping suffices until the [V1] admin queue outgrows it (A24.9).
