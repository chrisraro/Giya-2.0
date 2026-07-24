# 20 — Data Model Overview & Conventions

The canonical schema is split by domain: `21` identity/business, `22` catalog, `23` campaigns/points/rewards, `24` receipts/AI, `25` platform. DDL in those files is the source of truth; migrations are derived from it and docs update in the same PR as any migration.

## Domain map (ERD, high level)

```
auth.users ──1:1── profiles ──1:1── consumers
    │                │
    │                └──< platform_admins
    │
    └──< business_staff >── businesses ──< business_verifications ──< business_documents
                               │
        ┌──────────────────────┼───────────────────────────────┐
        │                      │                               │
   menu_categories        campaigns ──< campaign_schedules     receipt_templates
        │                      │                                    │
   products ──< product_variants│                                   │
        │  └──< product_addons  ├──< promotions (type detail)       │
        │                      ├──< rewards ──< reward_inventory    │
        │                      ├──< loyalty_programs ──< loyalty_cards
        │                      └──< points_rules                    │
        │                                                           │
   business_customers >──────── consumers                           │
        │                          │                                │
        │                      receipts ──1:1── ocr_results ────────┘
        │                          │        └──< receipt_line_items
        │                          └──< fraud_signals
        │
   points_transactions (append-only ledger; consumer × business)
   reward_claims ──< redemptions
        │
   qr_codes · reviews · favorites · notifications · user_devices
   embeddings · ai_conversations ──< ai_messages · ai_usage_events
   announcements · faqs · feature_flags · settings · audit_logs
   jobs · exports · feedback · analytics_daily_business (rollups)
   ref_cities · ref_business_types · ref_food_types · tags
```

## Universal conventions (every table, no exceptions unless noted)

| Convention | Standard |
|---|---|
| Primary key | `id uuid primary key default uuid_generate_v7()` — UUIDv7 (time-ordered: index-friendly, partition-friendly, non-guessable enough for URLs combined with authz) |
| Audit fields | `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()` (trigger-maintained), `created_by uuid references auth.users(id)`, `updated_by uuid` — `created_by/updated_by` nullable for system-created rows |
| Soft delete | `deleted_at timestamptz null` on business-meaningful tables (products, campaigns, rewards, businesses, reviews …). All read paths filter `deleted_at is null`. **Not** on ledger/immutable tables (`points_transactions`, `audit_logs`, `ocr_results`) — those never delete |
| Tenancy | `business_id uuid not null references businesses(id)` on every tenant-scoped table (see `12-multi-tenancy-rls.md`) |
| RLS | Enabled on every table; policy pattern (P1–P4) cited per table |
| Money | `integer` centavos + implied `PHP` (multi-currency column reserved `[SCALE]`) |
| Points | `integer` (whole points; no fractional points — product rule) |
| Enums | Postgres `check` constraints on `text` (cheaper to extend than PG enums); allowed values listed in the enum registry below and mirrored in `src/lib/constants.ts` |
| Naming | snake_case; tables plural; join tables `a_b`; booleans `is_`/`has_`; timestamps `_at`; FKs `{entity}_id` |
| Indexes | Every FK indexed; tenant-scoped hot paths use composite `(business_id, …)` indexes; partial indexes for status-filtered hot queries |
| Timestamps | `timestamptz` always; app layer treats everything as UTC; display TZ `Asia/Manila` |

Shared trigger:

```sql
create or replace function private.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
-- applied per-table:  create trigger t before update on X
--                     for each row execute function private.touch_updated_at();
```

UUIDv7: use `pg_uuidv7` extension (or inline function fallback) — migration `0001_extensions.sql` installs `pg_uuidv7`, `pgcrypto`, `vector`, `pg_trgm`, `unaccent`.

## Enum registry (canonical values)

| Enum | Values |
|---|---|
| `platform_admin_role` | `super_admin` · `admin` · `support` |
| `business_staff_role` | `owner` · `manager` · `marketing` · `staff` |
| `business_status` | `draft` · `pending_verification` · `active` · `suspended` · `closed` |
| `verification_status` | `pending` · `approved` · `rejected` · `revision_requested` |
| `document_type` | `business_permit` · `mayors_permit` · `tin` · `dti` · `sec` · `sample_receipt` · `other` |
| `campaign_type` | `promotion` · `reward` · `discount` · `referral` · `event` · `seasonal` · `birthday` · `holiday` · `membership` · `loyalty` |
| `campaign_status` | `draft` · `scheduled` · `active` · `paused` · `ended` · `archived` |
| `points_rule_type` | `amount_rate` · `fixed_per_visit` · `fixed_per_receipt` · `tiered_amount` |
| `points_txn_type` | `earn` · `redeem` · `adjust` · `expire` · `clawback` · `reversal` · `referral_bonus` |
| `receipt_status` | `queued` · `processing` · `review` · `approved` · `rejected` |
| `receipt_source` | `scan` · `pos` `[SCALE]` · `digital` `[SCALE]` |
| `receipt_reject_reason` | `duplicate` · `unreadable` · `wrong_business` · `too_old` · `fraud_suspected` · `manual` |
| `reward_claim_status` | `claimed` · `redeemed` · `expired` · `cancelled` |
| `loyalty_program_type` | `visit_count` · `points_target` · `receipt_count` · `spend_amount` · `custom` |
| `notification_channel` | `push` · `email` · `in_app` |
| `notification_status` | `pending` · `sent` · `delivered` · `failed` · `read` |
| `job_status` | `queued` · `running` · `succeeded` · `failed` · `dead` |
| `fraud_signal_type` | `image_hash_dup` · `ocr_similarity_dup` · `receipt_number_dup` · `velocity` · `timestamp_anomaly` · `gps_mismatch` · `amount_anomaly` · `ai_confidence_low` · `staff_self_scan` `[MVP v1.1]` · `referral_abuse` `[V1 v1.1]` · `device_shared` `[V1 v1.1]` (`26-schema-amendments.md`) |
| `review_status` | `published` · `flagged` · `removed` |
| `segment` | `regular` · `vip` · `blacklisted` |
| `qr_type` | `business` · `campaign` · `reward` · `menu` |
| `content_status` | `draft` · `published` · `archived` |
| `knowledge_kind` `[V1 v1.1]` | `faq` · `policy` · `document` (`business_knowledge`, `26-schema-amendments.md`) |
| `integration_provider` `[V1 v1.1]` | `meta_business` · `google_business` (`integration_connections`, `26-schema-amendments.md`) |
| `integration_status` `[V1 v1.1]` | `connected` · `expired` · `revoked` · `error` (`integration_connections`, `26-schema-amendments.md`) |

Adding a value = migration updating the `check` constraint + `constants.ts` + this table, one PR.

## Balances are derived, ledger is truth

`points_transactions` is append-only (INSERT-only grants; no UPDATE/DELETE even for service role — corrections are compensating entries). Fast reads come from `business_customers.points_balance`, maintained **in the same transaction** as ledger inserts by the points service, and re-derivable at any time:

```sql
select coalesce(sum(points),0) from points_transactions
 where business_id = $1 and consumer_id = $2;
```

A nightly integrity job re-derives balances for a sample (full scan weekly) and alerts on drift (`52-monitoring-observability.md`). The same pattern applies to `reward_inventory.remaining` and loyalty card progress.

## Partitioning readiness `[SCALE]`

`points_transactions`, `receipts`, `audit_logs`, `notifications` are the growth tables. They are created unpartitioned but with: UUIDv7 PKs, `created_at` in every hot index, and no cross-month FK dependencies that would block `PARTITION BY RANGE (created_at)`. The cutover plan (create partitioned twin → backfill → swap) is a `[SCALE]` runbook, not a schema change.

## Full-text & vector columns

- FTS: `businesses.search_tsv`, `products.search_tsv` — generated columns (`to_tsvector('simple', unaccent(...))` over name/description/tags), GIN-indexed. `pg_trgm` GIN on `businesses.name` for fuzzy match (`36` receipt merchant matching).
- Vectors: single `embeddings` table (halfvec(1024), BGE-M3) with `source_type/source_id` polymorphic reference + denormalized `business_id` — detail in `24-schema-receipts-ai.md`.
