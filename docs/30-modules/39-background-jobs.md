# 39 — Background Services & Queues

Everything slow, external, retryable, or bursty runs behind a queue (`../10-architecture/10-system-architecture.md` D3). This document is the canonical queue registry: a queue that is not listed here does not exist, and adding one requires a PR that updates this file (per the PR checklist in `../10-architecture/14-development-standards.md`).

## Architecture recap

- **QStash (Upstash)** delivers each job as an HTTPS callback to a worker Route Handler under `/api/workers/{queue}` (route files in `src/app/api/workers/**`, logic in `src/workers/**` per `../10-architecture/14-development-standards.md`). No long-lived consumer process exists anywhere.
- **Postgres is the truth** (D4): every job has a row in `jobs` (`../20-data/25-schema-platform.md`) — `queue`, `status` (`queued|running|succeeded|failed|dead`), `payload`, `business_id`, `dedupe_key`, `attempts`, `max_attempts` (default 5), `last_error`, `scheduled_at`, `started_at`, `finished_at`. Losing QStash or Redis loses delivery/speed, never state.
- **Redis is coordination only**: job progress (`{env}:jobs:progress:{job_id}`), heartbeats, dedup locks, circuit-breaker state. All keys have TTLs; all are rebuildable from Postgres.
- **Workers are stateless, idempotent, service-role zone.** `createServiceClient()` is lint-fenced to `src/workers/**` per `../10-architecture/12-multi-tenancy-rls.md`. Worker state changes that matter write `audit_logs` with `actor_kind = 'worker'`.

Enqueue path (only via `src/lib/queue/enqueue.ts`, never raw QStash SDK calls from features):

```
enqueue(queue, payload, {businessId?, dedupeKey?, delay?, flowControlKey?})
  1. INSERT jobs (status='queued', dedupe_key, business_id)      -- jobs_dedupe_idx
     ON CONFLICT on (queue, dedupe_key) where queued/running → return existing job (no double-publish)
  2. qstash.publishJSON({ url: /api/workers/{queue}, body: {job_id, ...payload},
       headers: {traceparent}, retries: max_attempts-1, flowControl })
  3. store qstash message id for DLQ correlation (see Schema deltas)
```

Row insert precedes publish; a crash between 1 and 2 leaves a `queued` row that the reconciler sweep re-publishes (see Scheduling).

## Worker invocation contract

Every worker handler executes, in order:

1. **Signature verification.** `Upstash-Signature` verified against current + next QStash signing keys (`src/lib/queue/verify.ts`). Failure → 401, no processing, Sentry event. No other caller can reach `/api/workers/*` (also excluded from `/api/v1` docs and CORS).
2. **Zod-parse payload** (each queue's schema in `src/workers/{area}/schemas.ts`). Malformed → terminal failure (see taxonomy).
3. **Claim the job row (optimistic):**
   ```sql
   update jobs set status='running', attempts = attempts + 1, started_at = now()
    where id = $1 and status in ('queued','failed')
   returning *;
   ```
   - 0 rows and `status='succeeded'` → return 200 (duplicate delivery; idempotent no-op).
   - 0 rows and `status='running'` with a **live heartbeat** → 200 (concurrent duplicate; the other invocation owns it).
   - 0 rows and `status='running'` with expired heartbeat → reclaim (same UPDATE with `status='running'` + `started_at < now() - interval 'timeout'` predicate).
   - `attempts >= max_attempts` after increment → mark `dead`, return 200.
4. **Do the work** — side effects idempotent by domain key (e.g. `pt_receipt_earn_once` makes double-award impossible at the DB per `../20-data/23-schema-campaigns.md`).
5. **Finish:** `status='succeeded'|'failed'|'dead'`, `finished_at`, `last_error`; delete Redis progress keys.
6. **Return** 200 (done or terminal) / 5xx (retryable — QStash retries with backoff).

**Heartbeat (long jobs only):** Redis `SET {env}:jobs:hb:{job_id} EX 60` refreshed every 20s. Required for any worker with `maxDuration > 60`.

**Timeout budget** — each worker route exports `maxDuration` (Vercel Fluid compute; hard-cap awareness, never rely on >300s):

| Worker route | maxDuration | Notes |
|---|---|---|
| `ocr.process` | 120s | OCR service call capped at 90s client-side |
| `ai.embed_refresh`, `ai.parse_assist` | 120s | batch embeds chunked ≤64 texts/call |
| `notify.push`, `notify.email`, `images.process` | 60s | |
| `exports.generate`, `analytics.daily_rollup`, `integrity.balance_check` | 300s | must chunk + fan-out, never "one big loop" |
| all sweeps/cleanup | 60s | each run processes a bounded batch, re-enqueues itself if more remain |

## Queue registry (canonical)

Payload shapes are summarized; full Zod schemas live in `src/workers/{area}/schemas.ts`. Every payload includes `job_id`. Retry semantics follow the shared policy below unless a queue overrides it. Overview, then per-queue contracts:

| Queue | Phase | Trigger | Flow-control key |
|---|---|---|---|
| `ocr.process` | [MVP] | receipt submission | `ocr` (parallelism 10) |
| `ai.embed_refresh` | [V1] | knowledge writes + weekly sweep | `ai:embed` (parallelism 4) |
| `ai.parse_assist` | [V1] | low parse confidence | `ai:parse` (parallelism 4) |
| `notify.push` | [MVP] | domain events + campaign fan-out | `notify:{business_id}` (rate 20/s) |
| `notify.email` | [MVP txn / V1 mkt] | domain events + marketing sends | `email:{business_id}` (rate 10/s) |
| `images.process` | [MVP] | media upload | `images` (parallelism 8) |
| `campaigns.sweep` | [MVP] | schedule */5 min | `sweep` (parallelism 1) |
| `points.expiry_sweep` | [V1] | schedule daily | `sweep` |
| `points.expiry_warn` | [V1] | schedule daily | `sweep` |
| `claims.expiry_sweep` | [MVP] | schedule hourly | `sweep` |
| `qr.scan_flush` | [MVP] | schedule */5 min | `sweep` |
| `cleanup.temp` / `cleanup.exports` / `cleanup.devices` / `cleanup.notifications` | [MVP; notifications daily] | schedules | `cleanup` |
| `exports.generate` | [V1] | export request | `exports:{business_id}` (parallelism 1/tenant) |
| `analytics.daily_rollup` | [MVP] | schedule nightly | `analytics` (parallelism 4) |
| `integrity.balance_check` | [MVP] | schedule nightly/weekly | `analytics` |
| `fraud.weekly_report` | [V1] | schedule weekly | `analytics` |
| `fraud.ring_sweep` | [V1] | schedule nightly | `analytics` |

### `ocr.process` [MVP]
- **Purpose:** the F1 money flow — preprocess → OCR (OCR service) → parse (template match, `36-receipt-ocr-pipeline.md`) → fraud checks (`37-fraud-detection.md`) → business match → points award (`35-points-engine.md`) → status + `notify.push`.
- **Trigger:** `POST /api/v1/receipts` after the `receipts` row (status `queued`) and image store succeed.
- **Payload:** `{job_id, receipt_id, user_id}` — the worker re-reads everything else from the `receipts` row; payloads carry identifiers, never denormalized state that can go stale.
- **Dedupe key:** `receipt_id`. **Idempotency:** terminal no-op if `receipts.status` is already final; the `pt_receipt_earn_once` unique index makes double-award impossible even under races.
- **Writes:** `ocr_results` (one per attempt, immutable), `fraud_signals`, parsed fields + status on `receipts`, ledger rows via the points service, `ai_usage_events.kind='ocr'`.
- **Failure notes:** OCR-service unavailability is retryable; unreadable image is terminal (`receipts.status='rejected'`, `reject_reason='unreadable'` — a *successful* job with a negative domain outcome, not a job failure).

### `ai.embed_refresh` [V1]
- **Purpose:** (re)embed business knowledge into `embeddings` (BGE-M3) for RAG (`38-ai-rag-platform.md`).
- **Trigger:** `catalog.updated` and profile/promotion/FAQ/hours writes (service-emitted, `../20-data/22-schema-catalog.md` design note); weekly consistency sweep (orphan deletion per `../20-data/24-schema-receipts-ai.md`).
- **Payload:** `{job_id, business_id, source_type?, source_id?}` — absent source = full-tenant refresh.
- **Dedupe key:** `business_id:source_type:source_id`; additionally debounced 60s in Redis so bulk menu edits coalesce into one job.
- **Idempotency:** `content_hash` on `embeddings` skips unchanged chunks; upsert on `(source_type, source_id, chunk_index)`.

### `ai.parse_assist` [V1]
- **Purpose:** LLM fallback field extraction when template parse confidence is below threshold (`36`), before falling to human review.
- **Payload:** `{job_id, receipt_id, ocr_result_id}`. **Dedupe key:** `receipt_id:ocr_result_id`.
- **Guards:** per-tenant daily AI budget (LLM gateway); meters `ai_usage_events.kind='parse_assist'`. AI output never auto-approves on its own below confidence floor — review queue is the backstop (golden rule 5, `../README.md`).

### `notify.push` [MVP] / `notify.email` [MVP transactional, V1 marketing]
- **Purpose:** all FCM / Resend sends — transactional (points_awarded, receipt_rejected, reward_claimed, staff_invite, …) and campaign fan-out (F4).
- **Trigger:** domain events enqueue single-recipient batches; campaign activation materializes the audience and enqueues **batches of 500 `notifications` per job** (F4).
- **Payload:** `{job_id, notification_ids: uuid[] (≤500), campaign_id?}` (+ `template` key for email). `notifications` rows are pre-inserted `status='pending'` at fan-out time — the fan-out is durable before the first send.
- **Dedupe key:** `campaign_id:chunk_no` for blasts; `notification_id` for singletons.
- **Idempotency:** worker sends only rows still `pending`, updating `status`/`sent_at`/`error` per row — a replayed batch re-sends nothing already `sent`.
- **Guards:** `consumers.push_enabled` / `email_enabled` / `marketing_opt_in` re-checked in the worker (not only at fan-out); invalid FCM tokens revoke `user_devices` rows per `42-integrations.md`; per-tenant flow-control key prevents blast starvation.

### `images.process` [MVP]
- **Purpose:** resize/re-encode/variant generation for uploaded media (products, logos, covers, promos, rewards) — pre-sized variants per the scaling table (`../10-architecture/10-system-architecture.md`). Receipt images are *not* processed here (OCR service preprocesses).
- **Payload:** `{job_id, bucket, path, owner: {type, id}, variants: string[]}`. **Dedupe key:** `bucket:path`.
- **Notes:** sharp re-encode strips EXIF/GPS + embedded payloads per `../10-architecture/15-security.md`; writes variant paths back to the owning row (`products.images`, `businesses.logo_url`, …).

### `campaigns.sweep` [MVP]
- **Purpose:** the campaign clock — activate `scheduled` campaigns whose window opened, end past-`ends_at` campaigns, pause budget-exhausted ones (`34-campaign-engine.md` state machine).
- **Trigger:** schedule every 5 min. **Payload:** `{job_id, window_ts}`; **dedupe key** `window_ts` (one sweep per tick even if double-delivered).
- **Notes:** driven by `campaigns_active_window_idx` (`../20-data/23-schema-campaigns.md`); every transition writes `audit_logs` and emits notification events; suspension auto-pause (`../10-architecture/12-multi-tenancy-rls.md` tenant lifecycle) also lands here.

### `points.expiry_sweep` [V1]
- **Purpose:** enforce point expiry — MVP *sets* `points_transactions.expires_at` on earn rows; this job writes the `expire` ledger entries FIFO (`35-points-engine.md`).
- **Payload:** `{job_id, day, business_ids?: uuid[]}` — orchestrator chunks by business. **Dedupe key:** `day:chunk`.
- **Notes:** uses `pt_expiry_idx`; every expiry is an append-only compensating entry, never an edit (golden rule 3).

### `points.expiry_warn` [V1]
- **Purpose:** expiry warnings — runs the `35-points-engine.md` §7 formula at horizons `now()+30d` and `now()+7d`; positive projected remainder → notification `kind='points_expiring'`.
- **Trigger:** schedule daily. **Payload:** `{job_id, day, horizon: '30d'|'7d', business_ids?: uuid[]}`. **Dedupe key:** `day:horizon:chunk` (also dedupes the per-pair notification per horizon).

### `claims.expiry_sweep` [MVP]
- **Purpose:** flip `reward_claims` `claimed→expired` past `expires_at`; restore reward inventory and refund points-priced claims per the reversal rules in `35`.
- **Trigger:** hourly. **Payload:** `{job_id, window_ts}`; **dedupe key** `window_ts`. Uses `reward_claims_expiry_idx`.

### `qr.scan_flush` [MVP]
- **Purpose:** flush Redis QR scan counters (`{env}:qr:scans:{id}`, incremented by the public short-code resolver — no synchronous write on the read path, `34-campaign-engine.md` §8) into `qr_codes.scan_count`.
- **Trigger:** schedule every 5 min. **Payload:** `{job_id, window_ts}`; **dedupe key** `window_ts`. Idempotent: counters are read-and-reset atomically (`GETDEL`); a lost flush loses at most one window of counts, never double-counts.

### `fraud.ring_sweep` [V1]
- **Purpose:** nightly cross-consumer ring detection (`37-fraud-detection.md`): duplicate-evidence clusters, shared devices, referral abuse → ring cases in the admin fraud queue; emits `referral_abuse`/`device_shared` signal rows (`../20-data/26-schema-amendments.md`).
- **Trigger:** schedule nightly. **Payload:** `{job_id, day}`; **dedupe key** `day`. Reads `fraud_signals`, `receipts`, `user_devices`, `consumers.referred_by`; never auto-punishes (cases only).

### `cleanup.temp` / `cleanup.exports` / `cleanup.devices` / `cleanup.notifications` [MVP]
- **Purpose:** `temp` bucket objects >24h purged (hourly); `exports` bucket objects >7d purged + `exports.storage_path` nulled (daily); `user_devices` with `last_seen_at` >180d set `is_revoked=true` (weekly) — TTLs per `../10-architecture/11-tech-stack.md` storage rules and `../20-data/21-schema-identity.md`; `notifications` retention (daily, `30-platform-core.md` §5.7): delete in_app rows read >90d and push/email rows in terminal status >180d, except rows with `campaign_id` (kept until campaign archived + 180d).
- **Payload:** `{job_id, window_ts}`; **dedupe key** `window_ts`. Bounded batches (1,000 objects/rows per run) with self-re-enqueue when more remain.

### `exports.generate` [V1]
- **Purpose:** build CSV/report files for an `exports` row (`kind`: `customers_csv`, `campaign_report`, `my_data`, …) into the `exports` bucket; notify requester with a signed URL (1h TTL, `../10-architecture/15-security.md`).
- **Payload:** `{job_id, export_id}`. **Dedupe key:** `export_id`.
- **Notes:** streams keyset-paginated pages (1,000 rows) to storage — memory-flat at any tenant size; updates `exports.status/storage_path/error`; `my_data` exports serve the RA 10173 export-my-data right (`../10-architecture/15-security.md`).

### `analytics.daily_rollup` [MVP]
- **Purpose:** write `analytics_daily_business` for the just-closed Manila day (+ trailing-3-day re-roll for late review decisions) — formulas in `40-analytics.md`.
- **Payload:** `{job_id, day, business_ids?: uuid[]}` — an orchestrator run fans out chunks of ~500 businesses with jitter. **Dedupe key:** `day:chunk`.
- **Idempotency:** full recompute + upsert on `(business_id, day)`; reruns converge.

### `integrity.balance_check` [MVP]
- **Purpose:** re-derive `business_customers.points_balance` (and `rewards.remaining`, loyalty card progress) from the ledger; alert on drift. Nightly random sample (1% of active pairs), weekly full scan (`../20-data/20-data-model.md`).
- **Payload:** `{job_id, mode: 'sample'|'full', shard?: int}`. **Dedupe key:** `mode:day:shard`.
- **Notes:** **never auto-corrects** — drift pages on-call (`../50-ops/52-monitoring-observability.md`) and correction is a human-audited `adjust` ledger entry.

### `fraud.weekly_report` [V1]
- **Purpose:** weekly fraud digest per business (signal counts, blocked receipts, estimated leak) + platform aggregate for admin; delivered via `notify.email`.
- **Payload:** `{job_id, week_start}`. **Dedupe key:** `week_start`. Reads `fraud_signals`, `receipts`, and `clawback` ledger rows.

## Retry, backoff, failure taxonomy, DLQ

**Backoff:** QStash exponential backoff (`min(86400, 10 * 4^attempt)` seconds shape — config, not code). `retries` on publish = `jobs.max_attempts - 1` (default 5 total attempts). Long-delay retries are fine: jobs are not latency-critical once past attempt 1; F1's latency SLO is measured on first-attempt success.

**Failure taxonomy** (`src/workers/lib/errors.ts` classifies every thrown error):

| Class | Examples | Worker behavior |
|---|---|---|
| **Retryable** | OCR service 5xx/timeout, Groq 429/5xx, FCM/Resend transient, Postgres serialization failure, Redis unavailable | `jobs.status='failed'`, `last_error`, return 5xx → QStash retries |
| **Terminal** | Zod parse failure, referenced row gone/final-state (receipt already approved), FCM invalid-token (handled per-token, not job-fatal), business suspended, budget cap exceeded | `jobs.status='dead'` (skip retries), return 200, alert if unexpected class |
| **Exhausted** | retryable failed `max_attempts` times | QStash moves message to its DLQ; DLQ webhook / reconciler marks `jobs.status='dead'` |

**DLQ handling:** `status='dead'` rows are the operational DLQ view. Admin portal **Queue Status** screen (`31-admin-portal.md`) lists dead jobs per queue with `payload`, `last_error`, attempts, linked entity. Any queue with >0 dead jobs in 15 min alerts per `../50-ops/52-monitoring-observability.md`.

**Replay procedure:** admin action `job.replayed` (audited, reason required per `../10-architecture/15-security.md`): reset `attempts=0`, `status='queued'`, `last_error=null`, re-publish to QStash with the same `job_id`. Idempotency guarantees make replay always safe — that is the design bar for every worker. Bulk replay is the same action filtered by queue + time range.

## Scheduling (QStash schedules)

All cron in **UTC**; Manila is fixed UTC+8 (no DST). Schedules created idempotently by a deploy-time script (`scripts/sync-schedules.ts`) from this registry — drift between doc and QStash fails CI.

| Schedule | Cron (UTC) | Manila meaning | Enqueues |
|---|---|---|---|
| campaigns sweep | `*/5 * * * *` | continuous | `campaigns.sweep` |
| qr scan flush | `2-57/5 * * * *` | every 5 min (offset :02) | `qr.scan_flush` |
| claims expiry | `7 * * * *` | hourly at :07 | `claims.expiry_sweep` |
| temp cleanup | `23 * * * *` | hourly at :23 | `cleanup.temp` |
| daily rollup | `40 17 * * *` | 01:40 AM (closes prior Manila day) | `analytics.daily_rollup` |
| points expiry [V1] | `10 18 * * *` | 02:10 AM | `points.expiry_sweep` |
| points expiry warn [V1] | `25 18 * * *` | 02:25 AM | `points.expiry_warn` |
| balance check (sample) | `40 18 * * *` | 02:40 AM | `integrity.balance_check {mode:'sample'}` |
| balance check (full) | `40 19 * * 6` | Sun 03:40 AM | `integrity.balance_check {mode:'full'}` |
| exports cleanup | `55 19 * * *` | 03:55 AM | `cleanup.exports` |
| notifications cleanup | `5 20 * * *` | 04:05 AM | `cleanup.notifications` |
| devices cleanup | `15 20 * * 0` | Mon 04:15 AM | `cleanup.devices` |
| fraud ring sweep [V1] | `45 20 * * *` | 04:45 AM | `fraud.ring_sweep` |
| embed consistency sweep [V1] | `30 20 * * 0` | Mon 04:30 AM | `ai.embed_refresh` (orphan sweep mode) |
| fraud weekly [V1] | `0 0 * * 1` | Mon 08:00 AM | `fraud.weekly_report` |
| jobs reconciler | `50 * * * *` | hourly | re-publishes `queued` rows older than 10 min with no QStash delivery; marks orphaned `running` rows with dead heartbeats |

**Jitter:** minute offsets above are deliberately staggered; fan-out jobs additionally add `delay = random(0..120s)` per chunk so nightly work doesn't thundering-herd Supabase.

## Fairness at scale [designed now, tuned at SCALE]

- **Per-tenant flow control:** `notify.push`/`notify.email`/`exports.generate` publish with QStash flow-control key `{queue}:{business_id}` — one business's 200k-recipient blast queues behind its own key while other tenants' sends proceed. Global parallelism caps sit above per-tenant keys.
- **Batch sizing:** notification fan-out materializes recipients in chunks of **500 per job** (F4, `../10-architecture/10-system-architecture.md`); exports stream by cursor pages of 1,000.
- **Priority:** consumer-facing queues (`ocr.process`, transactional `notify.*`) get dedicated flow-control keys and are never behind analytics/cleanup keys. There is no in-band priority field; isolation-by-key is the mechanism.
- OCR throughput scales by raising the `ocr` parallelism cap together with OCR service replicas (scaling table, `../10-architecture/10-system-architecture.md`).

## Observability

- **Tracing:** enqueue attaches `traceparent` as a QStash forwarded header; workers extract and continue the trace → one trace spans API → QStash → worker → OCR/Groq/FCM (`../50-ops/52-monitoring-observability.md`).
- **Metrics (derived from `jobs`, emitted by a metrics endpoint scraped/pushed to OTel):** per queue — depth proxy (`count where status='queued'`), **age of oldest queued job** (`now() - min(scheduled_at)`), success rate (succeeded / finished, 1h window), duration p95 (`finished_at - started_at`), dead count. Alert thresholds in `52`.
- **Logging:** structured JSON per job: `job_id`, `queue`, `business_id`, `attempt`, outcome, duration. `request_id` = `job_id` for envelope correlation.
- Sentry captures classified-unexpected terminal errors with queue + job context (payload PII-scrubbed).

## Local development

- `npx @upstash/qstash-cli dev` runs a local QStash (signing keys in `.env.local`); schedules are not synced locally — sweeps are invoked manually.
- `pnpm worker:invoke <queue> <payload.json>` harness POSTs directly to the worker route with a locally-signed request — works with zero network deps; used by integration tests (`../50-ops/51-testing-strategy.md`).
- `QUEUE_INLINE=true` (local only, refused when `NODE_ENV=production` by `src/lib/env.ts`) makes `enqueue()` invoke the worker in-process — for E2E runs where async timing is noise.

## Schema deltas proposed

Ratified into `../20-data/26-schema-amendments.md`.

- `jobs.qstash_message_id` — **ACCEPTED** [MVP] (A25.2).
- `jobs.heartbeat_at` — **ACCEPTED** [MVP] (A25.2).
- Partial index `jobs_dead_idx` — **ACCEPTED** [MVP] (A25.2).
