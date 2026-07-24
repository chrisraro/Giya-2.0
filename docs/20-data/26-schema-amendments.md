# 26 — Ratified Schema Amendments (v1.1)

Deltas surfaced while writing the module specs (`../30-modules/`), reviewed and **ratified for inclusion**. They will be merged into files `21`–`25` when the corresponding migrations are authored (README golden rule 8: docs and schema move together, same PR). **Until then, this file is part of the canonical schema** — module docs may rely on everything marked ACCEPTED below.

Conventions per `20-data-model.md` (`-- +audit` = standard audit + soft-delete columns; UUIDv7 PKs; RLS patterns P1–P4 per `../10-architecture/12-multi-tenancy-rls.md`). Each amendment lists **source doc · phase · status**. Enum additions ratified here are mirrored in the enum registry in `20-data-model.md`.

## Decision summary (optional / decide items)

| Item | Decision | Rationale (one line) |
|---|---|---|
| `notifications.kind_class` (30) | **DEFERRED** | Classification already lives in the `kinds.ts` code registry (25 registry note); a column duplicates code-owned data for a rare retention query. |
| `business_verifications.submitted_round` (31) | **DEFERRED** | Round number is cheaply derived by counting prior rows at admin-queue volumes; revisit only if queue queries show strain. |
| `moderation_requests` table (31) | **DEFERRED** | Support suspension-request flow is [V1]; MVP unaffected; `audit_logs` action `suspension.requested` suffices until V1 planning decides. |
| `ai_conversations.language` (38) | **ACCEPTED [V1]** | Cheap column; documented AI analytics segmentation (language mix) depends on it — re-classifying chats later is costlier. |
| `fraud_cases` table (37) | **DEFERRED** | Ring/case grouping via `fraud_signals.evidence` JSONB is sufficient until the [V1] admin queue demonstrably outgrows it. |
| `email_suppressions` table (42) | **DEFERRED** | Speculative re-registration edge case; `consumers.email_enabled` auto-off (bounce webhook) is the documented mechanism. |
| `promotion_redemptions` table (34) | **DEFERRED [SCALE]** | Counter-honored promos have no in-system redemption event at MVP/V1 by design; adds counter friction for near-zero pilot value. |
| `receipts` image columns nullable for non-scan sources (36) | **DEFERRED [SCALE]** | Only needed when POS/digital source adapters are built; check-constraint relaxation lands with that work. |
| `events` table (40) | **DEFERRED [SCALE]** | Only if product analytics outgrows Vercel Analytics + domain tables; sketch recorded below for partition-readiness. |

---

## Amendments to `21-schema-identity.md`

### A21.1 `profiles.birth_date_updated_at` — source `../30-modules/30-platform-core.md` · [MVP] · ACCEPTED

Enforces the editable-once-per-rolling-year birth-date rule (30 §4.3) without an `audit_logs` scan on the hot path.

```sql
alter table public.profiles
  add column birth_date_updated_at timestamptz;
-- set by the profile service whenever birth_date changes; null = never set/changed
```

### A21.2 New table `user_consents` — source `../30-modules/30-platform-core.md` · [MVP capture; re-consent flow V1] · ACCEPTED

Records who accepted which `cms_pages` version; required for the versioned re-consent hook (30 §6.4) — `cms_pages.version` exists in 25 but nothing recorded acceptance.

```sql
-- RLS: P2 (insert/read own); no update/delete grants (consent records are immutable).
create table public.user_consents (
  id           uuid primary key default uuid_generate_v7(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  page_slug    text not null,               -- cms_pages.slug ('terms', 'privacy', …)
  version      integer not null,            -- cms_pages.version accepted
  consented_at timestamptz not null default now(),
  ip           inet,
  unique (user_id, page_slug, version)
);
create index user_consents_user_idx on public.user_consents (user_id, page_slug, version desc);
```

### A21.3 `consumers.scan_blocked_until` — source `../30-modules/37-fraud-detection.md` · [MVP] · ACCEPTED

Durable cooldown for the consequences ladder step 2 (Redis is the fast path; Postgres is truth per D4).

```sql
alter table public.consumers
  add column scan_blocked_until timestamptz;
-- submit during cooldown → 403 CONSUMER_SCAN_BLOCKED (37)
```

### A21.4 `businesses.rating_avg` + `businesses.rating_count` — source `../30-modules/33-consumer-pwa.md` · [V1] · ACCEPTED

Denormalized review aggregates maintained by the review service on publish/edit/remove, so business cards and ISR pages show ratings without aggregating `reviews` per render.

```sql
alter table public.businesses
  add column rating_avg   numeric(3,2) check (rating_avg between 1.00 and 5.00),
  add column rating_count integer not null default 0 check (rating_count >= 0);
```

### A21.5 `business_verifications.submitted_round` — source `../30-modules/31-admin-portal.md` · DEFERRED

See decision summary. No DDL ratified.

---

## Amendments to `22-schema-catalog.md`

No amendments proposed against the catalog schema in v1.1.

---

## Amendments to `23-schema-campaigns.md`

### A23.1 `points_rules.expires_after_days` — source `../30-modules/35-points-engine.md` · [MVP] · ACCEPTED

The earn pipeline must stamp `points_transactions.expires_at` (MVP roadmap: "expiry dates set"), but no schema location stored the business's expiry policy. Configured on the **base** rule (null = points never expire); the pipeline stamps `receipt_date + expires_after_days`. Portal warns on shortening the TTL (35 §7 FIFO monotonicity caveat).

```sql
alter table public.points_rules
  add column expires_after_days integer check (expires_after_days > 0);
```

### A23.2 Partial unique index `pt_referral_once` — source `../30-modules/35-points-engine.md` · [V1] · ACCEPTED

DB-enforces one referral grant per side per triggering receipt (35 §10); referrer and referee take different pair locks, so a service guard alone is race-prone.

```sql
create unique index pt_referral_once
  on public.points_transactions (consumer_id, receipt_id)
  where type = 'referral_bonus';
```

### A23.3 Partial unique index `pt_reverses_once` — source `../30-modules/35-points-engine.md` · [V1] · ACCEPTED

At most one `clawback`/`reversal` per original ledger row (35 §9); cheap to make structural on an immutable table.

```sql
create unique index pt_reverses_once
  on public.points_transactions (reverses_id)
  where reverses_id is not null;
```

### A23.4 `rewards.value_centavos` — source `../30-modules/40-analytics.md` · [V1] · ACCEPTED

Business-declared peso value of a reward; enables the honest consumer savings estimate and reward-cost reporting (no invented peso values).

```sql
alter table public.rewards
  add column value_centavos integer check (value_centavos >= 0);
```

---

## Amendments to `24-schema-receipts-ai.md`

### A24.1 `ocr_results.error` — source `../30-modules/36-receipt-ocr-pipeline.md` · [MVP] · ACCEPTED

Persists the failure reason on unsuccessful OCR attempts (previously only `jobs.last_error`, which is per-job, not per-attempt).

```sql
alter table public.ocr_results
  add column error text;
```

### A24.2 `receipts.parse_meta` — source `../30-modules/36-receipt-ocr-pipeline.md` · [MVP] · ACCEPTED

Per-field extraction provenance for the review UI chips: `{field: {tier: 'template'|'heuristic'|'llm', conf}}` — previously reconstructable only from logs.

```sql
alter table public.receipts
  add column parse_meta jsonb;
```

### A24.3 `fraud_signal_type` additions — sources `../30-modules/37-fraud-detection.md` · ACCEPTED

New values (check-constraint migration + `constants.ts` + the enum registry in `20-data-model.md`, one PR):

- `staff_self_scan` **[MVP]** — proper home for the S9 staff self-scanning guard (interim encoding under `velocity` retires with this migration).
- `referral_abuse` **[V1]** — ring-sweep referral-abuse cases as first-class signal rows.
- `device_shared` **[V1]** — ring-sweep shared-device cases as first-class signal rows.

```sql
alter table public.fraud_signals drop constraint fraud_signals_signal_check;
alter table public.fraud_signals add constraint fraud_signals_signal_check check (signal in
  ('image_hash_dup','ocr_similarity_dup','receipt_number_dup','velocity',
   'timestamp_anomaly','gps_mismatch','amount_anomaly','ai_confidence_low',
   'staff_self_scan',                       -- [MVP v1.1]
   'referral_abuse','device_shared'));      -- [V1 v1.1]
```

### A24.4 Trigram index on `ocr_results.raw_text` — source `../30-modules/37-fraud-detection.md` · [V1] · ACCEPTED

For S2 `ocr_similarity_dup` candidate search (`pg_trgm` `similarity()`); a normalized-text companion column may be added at migration time if index bloat demands.

```sql
create index ocr_results_rawtext_trgm
  on public.ocr_results using gin (raw_text gin_trgm_ops);
```

### A24.5 New table `business_knowledge` — source `../30-modules/38-ai-rag-platform.md` · [V1] · ACCEPTED

Tenant-authored FAQs, policies, and documents — the source rows for `embeddings.source_type` values `faq`, `policy`, `document` (the `faqs` table in 25 is platform CMS, admin-authored, not tenant content). Writes emit the `ai.embed_refresh` trigger (38 §2).

```sql
-- RLS pattern: P1 (owner/manager write; staff read own tenant). No public read path —
-- consumers see this content only through the assistant; retrieval runs service-role
-- against embeddings (RLS deny-all), per 24.
create table public.business_knowledge (
  id           uuid primary key default uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  kind         text not null check (kind in ('faq','policy','document')),
  title        text,                        -- policy/document title
  question     text,                        -- kind='faq'
  body         text,                        -- faq answer / policy section body
  storage_path text,                        -- kind='document' uploads; bucket: business-documents
  status       text not null default 'draft' check (status in ('draft','published')),
  check (kind <> 'faq' or question is not null),
  check (kind <> 'document' or storage_path is not null)
  -- +audit, +deleted_at
);
create index business_knowledge_biz_idx
  on public.business_knowledge (business_id, kind)
  where status = 'published' and deleted_at is null;
```

### A24.6 `embeddings.search_tsv` generated column + GIN index — source `../30-modules/38-ai-rag-platform.md` · [V1] · ACCEPTED

The FTS leg of hybrid retrieval (38 §3) in one SQL statement over the single embeddings table (per-source FTS was rejected: one query per source type).

```sql
alter table public.embeddings
  add column search_tsv tsvector
    generated always as (to_tsvector('simple', unaccent(content))) stored;
create index embeddings_tsv_idx on public.embeddings using gin (search_tsv);
```

### A24.7 `ai_conversations.language` — source `../30-modules/38-ai-rag-platform.md` · [V1] · ACCEPTED (see decision summary)

Detected on first message; lets analytics segment language mix without re-classifying chats.

```sql
alter table public.ai_conversations
  add column language text check (language in ('en','tl','taglish'));
```

### A24.8 `receipts` image columns nullable for non-scan sources — source `../30-modules/36-receipt-ocr-pipeline.md` · [SCALE] · DEFERRED

Relax `image_path`/`image_hash`/`sha256` to nullable **only** when `source <> 'scan'` (e.g. `check (source = 'scan' or image_path is not null)` per column) — lands with the POS/digital source adapters. No DDL ratified now.

### A24.9 `fraud_cases` table — source `../30-modules/37-fraud-detection.md` · [V1] · DEFERRED

See decision summary. Ring cases remain grouped evidence in the admin fraud queue.

---

## Amendments to `25-schema-platform.md`

### A25.1 `notifications.kind_class` — source `../30-modules/30-platform-core.md` · DEFERRED

Decision: **fold into the kind registry** — transactional/marketing classification lives on the kind entry in `src/features/notifications/kinds.ts` (30 §5.4), as that doc itself recommends. Retention/reporting SQL uses a generated kind list from the registry.

### A25.2 `jobs.qstash_message_id` + `jobs.heartbeat_at` + dead-jobs partial index — source `../30-modules/39-background-jobs.md` · [MVP] · ACCEPTED

Transport-level correlation with the QStash DLQ, durable heartbeat mirror for reclaim decisions when Redis was flushed, and the admin Queue Status dead-list index.

```sql
alter table public.jobs
  add column qstash_message_id text,        -- set on publish; DLQ correlation + transport dedup
  add column heartbeat_at      timestamptz; -- durable mirror of the Redis heartbeat (Redis stays the hot path)
create index jobs_dead_idx on public.jobs (queue, finished_at desc)
  where status = 'dead';
```

### A25.3 `analytics_daily_business` additions — sources `../30-modules/40-analytics.md`, `../30-modules/33-consumer-pwa.md` · ACCEPTED

- `visits` **[MVP]** — the canon visit rule (distinct consumer × Manila day); `receipts_approved` cannot serve.
- `receipts_submitted` **[MVP]** — per-tenant scan-funnel denominator (auto-approval rate per business).
- `favorites_added` **[V1]** — daily new `favorites` rows per business; required input for the trending score (33).

```sql
alter table public.analytics_daily_business
  add column visits             integer not null default 0,
  add column receipts_submitted integer not null default 0,
  add column favorites_added    integer not null default 0;   -- [V1]
```

### A25.4 New table `analytics_daily_platform` — source `../30-modules/40-analytics.md` · [V1] · ACCEPTED

Platform-wide daily rollup so admin dashboards avoid full scans over per-business rollups. Written by the nightly rollup orchestrator; RLS: admin read only (service writes).

```sql
create table public.analytics_daily_platform (
  day                       date primary key,
  businesses_active         integer not null default 0,
  businesses_verified_total integer not null default 0,
  consumers_new             integer not null default 0,
  wasc                      integer not null default 0,
  receipts_submitted        integer not null default 0,
  receipts_approved         integer not null default 0,
  receipts_rejected         integer not null default 0,
  gross_sales_centavos      bigint  not null default 0,
  points_earned             integer not null default 0,
  points_redeemed           integer not null default 0,
  ai_cost_micros            bigint  not null default 0,
  ocr_cost_micros           bigint  not null default 0
);
```

### A25.5 `notifications.opened_at` — sources `../30-modules/40-analytics.md`, `../30-modules/42-integrations.md` · [V1] · ACCEPTED

Deep-link open tracking (push open beacon) to close the push→visit attribution gap.

```sql
alter table public.notifications
  add column opened_at timestamptz;
```

### A25.6 New table `integration_connections` — source `../30-modules/42-integrations.md` · [V1] · ACCEPTED

Tenant OAuth connections (Meta Business at V1). A typed row beats an opaque `settings` JSONB: per-row encryption, expiry tracking, status lifecycle, uniqueness per external account, admin visibility. Tokens AES-256-GCM app-layer encrypted (`../10-architecture/15-security.md`), never logged, never selected by client-reachable query paths.

```sql
-- RLS: P1 owner/manager read own tenant (token columns excluded from client DTOs); writes service-only.
create table public.integration_connections (
  id                 uuid primary key default uuid_generate_v7(),
  business_id        uuid not null references public.businesses(id) on delete cascade,
  provider           text not null check (provider in ('meta_business','google_business')), -- extend by migration
  status             text not null default 'connected'
                       check (status in ('connected','expired','revoked','error')),
  external_account_id text not null,            -- FB Page ID / IG business account ID
  external_account_name text,
  scopes             text[] not null default '{}',
  access_token_encrypted  bytea not null,       -- AES-256-GCM app-layer
  refresh_token_encrypted bytea,
  token_expires_at   timestamptz,
  last_synced_at     timestamptz,
  error              text,
  unique (business_id, provider, external_account_id)
  -- +audit, +deleted_at
);
create index integration_connections_biz_idx
  on public.integration_connections (business_id, provider);
```

### A25.7 `email_suppressions` table — source `../30-modules/42-integrations.md` · DEFERRED

See decision summary; `consumers.email_enabled` remains the sole suppression mechanism.

### A25.8 `events` table — source `../30-modules/40-analytics.md` · [SCALE] · DEFERRED

Sketch recorded for partition-readiness (monthly `PARTITION BY RANGE (created_at)` per `20-data-model.md`); built only if product analytics outgrows Vercel Analytics + domain tables:

```sql
-- [SCALE] sketch — NOT ratified for migration
create table public.events (
  id          uuid primary key default uuid_generate_v7(),
  user_id     uuid,
  business_id uuid,
  name        text not null,
  props       jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
```

---

## Non-DDL registrations (data, not schema)

`../30-modules/36-receipt-ocr-pipeline.md` also registers **settings keys** (rows in `settings`, not DDL): `receipts.max_age_days` (business scope), `ocr.approve_threshold`, `ocr.review_threshold`, `ocr.max_attempts` (platform scope). Fraud threshold keys are registered in `../30-modules/37-fraud-detection.md`.
