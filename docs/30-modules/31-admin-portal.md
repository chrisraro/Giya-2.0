# 31 — Admin Portal

The `(admin)` route group: platform operations — verification, moderation, CMS, flags, monitoring, reports, audit. Access requires a `platform_admins` row (`is_platform_admin` claim, middleware per `../30-modules/30-platform-core.md` §2.5); role scoping per the canonical matrix in `../00-product/01-personas-roles.md` (`super_admin` / `admin` / `support` [V1]). Every admin action on tenant/user data records an `audit_logs` row **with a reason** (`../10-architecture/15-security.md`); this is service-enforced, not optional UI.

Data: `../20-data/21-schema-identity.md`, `../20-data/24-schema-receipts-ai.md`, `../20-data/25-schema-platform.md`. Mutations are Server Actions (portal-internal per D1 in `../10-architecture/10-system-architecture.md`); list/search reads that power TanStack Table go through `/api/v1/admin/*` Route Handlers (cursor pagination, admin rate limit 300/min per `../10-architecture/13-api-standards.md`).

## 1. Route/screen inventory — `(admin)`

| Route | Screen | Phase | Roles |
|---|---|---|---|
| `/admin` | Platform dashboard | [MVP basic, V1 full] | all admin roles |
| `/admin/verification` | Verification queue | [MVP] | admin, super_admin |
| `/admin/verification/[id]` | Verification detail + docs | [MVP] | admin, super_admin |
| `/admin/businesses` · `/admin/businesses/[id]` | Business lookup/detail | [MVP] | all (support read-only [V1]) |
| `/admin/consumers` · `/admin/consumers/[id]` | Consumer lookup/detail | [MVP] | all (support read-only [V1]) |
| `/admin/admins` | Platform admin management | [MVP] | super_admin only |
| `/admin/receipts` | Receipt review escalation queue | [MVP] | admin, super_admin |
| `/admin/fraud` | Fraud alerts & duplicate dashboard | [V1] | admin, super_admin |
| `/admin/content/{announcements,banners,faqs,pages,tags}` | CMS CRUD | [V1; announcements MVP-optional] | admin, super_admin |
| `/admin/content/reference` | `ref_cities` / `ref_business_types` / `ref_food_types` | [MVP seed UI acceptable; full V1] | admin, super_admin |
| `/admin/flags` | Feature flags | [V1 UI; flags exist MVP] | super_admin only |
| `/admin/monitoring/{ocr,ai,queues,duplicates}` | AI/OCR/queue monitoring | [V1] | admin, super_admin |
| `/admin/reports` | Report catalog + exports | [V1] | admin, super_admin |
| `/admin/audit` | Audit log viewer | [MVP] | admin, super_admin |
| `/admin/settings` | Platform settings, maintenance mode | [MVP minimal] | super_admin |

Layout: persistent sidebar (queue badges via Realtime admin counters — one of the three sanctioned Realtime uses, D5), top bar with global search (⌘K: businesses/consumers by name/email/slug). All tables: TanStack Table, server-side cursor pagination, skeleton loading, empty states with the active filter echoed ("No pending verifications — queue clear"), error → inline retry with `request_id` shown.

### 1.1 Data requirements per screen (primary reads)

| Screen | Tables/rollups read | Access path |
|---|---|---|
| Dashboard | `analytics_daily_business`, live counts (`businesses`, `receipts`, `business_verifications`, `jobs`, `ai_usage_events`) | RSC + 60s Redis cache |
| Verification queue/detail | `business_verifications`, `business_documents`, `businesses`, prior rounds | Route Handler list (cursor) + RSC detail; signed URLs on demand |
| Business/consumer lookup | `businesses` (+trgm/tsv indexes), `profiles`, `consumers`, `business_staff`, `business_customers`, `user_devices`, `fraud_signals` [V1] | `/api/v1/admin/businesses` · `/api/v1/admin/consumers` (cursor) |
| Admin management | `platform_admins` + `profiles` | RSC; writes via service-role Server Actions (RLS P4) |
| Receipt review | `receipts` (`status='review'`), `ocr_results`, `fraud_signals`, `receipt_line_items` | Route Handler queue + RSC detail |
| Fraud dashboard [V1] | `fraud_signals`, `receipts` (hash indexes) | Route Handler (cursor) |
| CMS screens | `announcements`, `banners`, `faqs`, `cms_pages`, `tags`, `ref_*` tables | RSC; Server Action writes + `revalidateTag` |
| Flags | `feature_flags`, `settings` (beta cohort) | RSC; super_admin Server Actions |
| Monitoring [V1] | `ocr_results`, `ai_usage_events`, `ai_messages`, `jobs` | RSC aggregates, 60s cache |
| Reports [V1] | `exports` + report queries | Server Action submit; requester-scoped list |
| Audit viewer | `audit_logs` (indexed filters only) | Route Handler (cursor) |

## 2. Dashboard

Tiles combine `analytics_daily_business` rollups (nightly job, `../30-modules/40-analytics.md`) with live counts. Each tile: value, Δ vs prior period, sparkline (Tremor), click-through to its queue/report.

| Tile | Phase | Query behind it |
|---|---|---|
| WASC (weekly active scanning consumers) | [MVP] | Canonical definition in `../30-modules/40-analytics.md`: consumers with ≥1 **approved** receipt in trailing 7 days — `count(distinct user_id) from receipts where status='approved' and created_at > now()-interval '7 days'` (live; rollup-backed trend [V1]) |
| Verified active businesses | [MVP] | live `count(*) from businesses where status='active' and deleted_at is null` |
| Scan success rate (7d) | [MVP] | `sum(receipts_approved)/(sum(receipts_approved)+sum(receipts_rejected))` from `analytics_daily_business` last 7 days |
| Pending verifications + oldest age | [MVP] | live count on `business_verifications where status='pending'` (`bv_status_idx`) |
| Receipts in review | [MVP] | live count `receipts where status='review'` (`receipts_review_idx`) |
| Consumer growth (30d) | [MVP] | `consumers` created_at buckets (live; rollup [V1]) |
| Points issued / redeemed (7d) | [V1] | `sum(points_earned)`, `sum(points_redeemed)` from `analytics_daily_business` |
| AI/OCR usage & cost (7d) | [V1] | `ai_usage_events`: units + `cost_micros` grouped by `kind` |
| Queue health | [V1] | `jobs` counts by `queue,status` where status in ('queued','running','dead') |
| Platform revenue | [SCALE] | plan billing (PayMongo) — designed, not built |

Dashboard reads are RSC + 60s Redis-cached aggregates; no dashboard query may scan un-indexed ranges (rollups are the discipline).

## 3. Business verification workflow [MVP]

The queue that turns `pending_verification` tenants into `active` ones. Personas context: `../00-product/01-personas-roles.md` ("Ops"). Submission side: `../30-modules/32-business-portal.md` §2.

### 3.1 Queue (`/admin/verification`)
- Rows: `business_verifications where status='pending'` joined to `businesses` (name, city, type) — columns: business, submitted (`created_at`), round # (count of prior rows for the business), docs count, age. Sort: oldest first (SLA order). Filters: city, business type, round (first-time vs resubmission).
- SLA: target decision < 2 business days. Queue header shows p50/p95 age of pending items and breach count (age > 48h highlighted). Metrics tile: decisions/day, approval rate, avg rounds-to-approval (from this table's history).

### 3.2 Detail (`/admin/verification/[id]`)
Data requirements: the `business_verifications` row (`registered_name`, `registration_type`, `tin_masked` — never plaintext; decrypt is super_admin + reason only, per 15), applicant `notes`, all `business_documents` for the round (`doc_type`, `file_name`, `size_bytes`, `expires_on`), business profile snapshot, prior rounds with decisions (`bv_business_idx` order).
- **Document viewer:** signed URLs from private `business-documents` bucket, TTL 5 min, **every generation audit-logged** (`document.url_signed`) per 15. Inline PDF/image viewer; re-request URL on expiry.
- **Decisions** (Server Actions, state machine on `business_verifications.status`):
  - `approve` → status `approved`, `decided_by`/`decided_at` set; `businesses.status → 'active'`, `verified_at=now()`. Notify kind `verification_decision`.
  - `reject` → status `rejected`, **`decision_reason` required** (`422 DECISION_REASON_REQUIRED` if blank); business stays `pending_verification`; owner may start a new round.
  - `request_revision` → status `revision_requested` + required `decision_reason`; owner edits docs and resubmits → **new** `business_verifications` row (one row per round, 21) linking docs via `verification_id`.
- Decisions on a non-pending row → `409 VERIFICATION_INVALID_STATE`. All decisions: audit action `verification.approved|rejected|revision_requested` with before/after and reason.

## 4. User management

### 4.1 Platform admins (`/admin/admins`) — super_admin only [MVP]
CRUD on `platform_admins` (`role`, `is_active`, `mfa_enforced` — default true; MFA mandatory enforcement [V1], TOTP per 15). Guards: cannot deactivate/demote the last active `super_admin` → `409 LAST_SUPER_ADMIN`; self-demotion confirmed with typed name. Writes are service-role (RLS P4) via Server Action; audit `admin.role_changed`, `admin.deactivated`.

### 4.2 Businesses & consumers lookup [MVP]
- Search: businesses by name (`businesses_name_trgm`), slug, city, status; consumers by display name/email/phone. Endpoints `GET /api/v1/admin/businesses`, `/api/v1/admin/consumers` (cursor).
- Business detail: profile, staff roster (`business_staff`), verification history, campaign/receipt counters, recent audit trail (tenant-scoped). Consumer detail: profile + `consumers` fields, device list, receipt stats, per-business `business_customers` standings, fraud signal history (`fraud_signals_consumer_idx`) [V1].
- Admin edits of tenant data are constraint 🟡¹ of the matrix: allowed for support/moderation, always audited with reason (modal forces reason text before save).

### 4.3 Suspension flows [MVP]
- Consumer/user: set `profiles.is_suspended=true` + `suspended_reason` (required) → refresh tokens revoked, middleware behavior per `../30-modules/30-platform-core.md` §2.8. Unsuspend clears both. Audit `profile.suspended` with reason.
- Business: `businesses.status='suspended'` + `suspended_reason` → portal blocked, public page hidden, campaigns auto-paused (worker), per `../10-architecture/12-multi-tenancy-rls.md`. Blank reason → `422 SUSPENSION_REASON_REQUIRED`.
- `support` role [V1]: read-only everywhere; may file a *suspension request* (a `feedback`-style internal note is insufficient — request lands as an audit-logged pending action for admin approval; UI: "Request suspension" instead of "Suspend"). No destructive actions per matrix.

## 5. Receipt & fraud review queues

Pipeline/rule semantics live in `../30-modules/36-receipt-ocr-pipeline.md` and `../30-modules/37-fraud-detection.md`; this section is the admin UI contract only.

- `/admin/receipts` [MVP]: escalation queue over `receipts where status='review'` — business staff review their own tenant's flagged receipts first (matrix: owner/manager + admin); items reach the admin queue when escalated by 36 (cross-tenant patterns, staff dispute, or business inactivity > SLA). Row: thumbnail (signed URL, 5-min TTL), business, consumer, parse/match confidence, tripped `fraud_signals` chips (severity-colored). Actions: approve (→ points award via 35), reject (`reject_reason` enum from 24 + optional `reject_note`), both audited; `reviewed_by`/`reviewed_at` stamped.
- `/admin/fraud` [V1]: fraud alert feed from `fraud_signals` (filter by `signal`, `severity`, business, consumer); duplicate-ring view groups `image_hash_dup`/`ocr_similarity_dup` evidence (`evidence.matched_receipt_id`, hamming distance) across consumers. Actions link back to receipt decisions and consumer suspension (§4.3).

## 6. Content management [CMS full V1; reference-data seeding MVP]

CRUD + publish workflow for `announcements`, `banners`, `faqs`, `cms_pages`, `tags`, and reference tables (`ref_cities`, `ref_business_types`, `ref_food_types`). Consumption contract: `../30-modules/30-platform-core.md` §6.

- Shared publish pattern: `draft → published → archived` status columns; publish/schedule via `publish_at`/`starts_at`/`ends_at` where the table has them (`announcements`, `banners`); preview renders the consumer component in a drawer before publish.
- `cms_pages` kind `legal`: publishing bumps `version` (+ confirmation warning: "this forces re-consent for all users" — flow in 30 §6.4). Markdown editor with sanitized preview.
- Reference tables: soft on/off via `is_active` (never delete a `ref_city` in use); `ref_business_types.sort` drag-ordering.
- Every mutation: `revalidateTag` per `src/lib/cache-tags.ts` + audit (`cms.page_published`, `cms.banner_created`, …). Role: admin + super_admin (matrix row "CMS / announcements / banners").

## 7. Feature flags (`/admin/flags`) — super_admin only [V1 UI]

`feature_flags` (25): `key`, `description`, `is_enabled`, `rollout` JSONB. Evaluation semantics (implemented once in `src/lib/flags.ts`, used server + client):

1. `is_enabled=false` → off for everyone (kill switch, wins over rollout).
2. `rollout.business_ids: [uuid]` → explicit allowlist (subject: active tenant) — on.
3. `rollout.plans: ["growth"]` → on when `businesses.plan` matches [SCALE enforcement].
4. `rollout.beta: true` → on when subject is in the beta cohort (`settings` platform row `key='beta_testers'`, `value={user_ids:[…], business_ids:[…]}`).
5. `rollout.percent: 25` → deterministic bucket: `hash(flag_key + subject_id) % 100 < percent` (stable per subject; no re-rolls).
6. Empty `rollout` `{}` + `is_enabled=true` → on for everyone.

UI: flag list with evaluated "who sees this" summary, percent slider, business-id picker, JSON editor with Zod validation, and a per-flag audit trail (flips are audited: `flag.updated`, before/after JSONB). Maintenance mode lives on `/admin/settings` using the `settings` pattern (30 §6.6), same audited toggle discipline.

## 8. AI/OCR monitoring [V1]

| Screen | Backing data | Contents |
|---|---|---|
| `/admin/monitoring/ocr` | `ocr_results`, `receipts` | OCR success rate (mean_confidence distribution, attempts>1 rate), p50/p95 `duration_ms`, engine_version cohorts; failure reasons = `receipts.reject_reason` breakdown + `review` inflow rate; per-template hit rate (`template_id` match share) |
| `/admin/monitoring/ai` | `ai_usage_events`, `ai_messages` | tokens/cost by `kind` and business (top spenders vs budget caps, `../30-modules/38-ai-rag-platform.md`), cache hit rate (`was_cached`), latency, feedback up/down ratio |
| `/admin/monitoring/queues` | `jobs` | per-`queue` depth by status, oldest `scheduled_at`, attempts histogram, `dead` list with `last_error` + requeue action (audited); mirrors `../30-modules/39-background-jobs.md` observability |
| `/admin/monitoring/duplicates` | `fraud_signals`, `receipts` | duplicate receipts dashboard: dup submissions/day by signal type, top offending consumers, cross-tenant rings (37) |

Alert thresholds (paging lives in `../50-ops/52-monitoring-observability.md`): auto-approval < 70% [MVP exit], dead jobs > 0 for money queues, AI cost/day breach.

## 9. Reports & exports [V1]

Catalog (`/admin/reports`) — each report = parameterized query + export kind:

| Report | `exports.kind` | Params |
|---|---|---|
| Businesses (status/verification funnel) | `businesses_report` | date range, city, status |
| Consumers (growth/activity) | `consumers_report` | date range, city |
| Rewards (claims/redemptions) | `rewards_report` | date range, business? |
| Campaigns performance | `campaign_report` | date range, type |
| Promotions | `promotions_report` | date range |
| OCR quality | `ocr_report` | date range |
| AI usage/cost | `ai_usage_report` | date range |
| Platform usage & growth | `growth_report` | date range |

Flow: submit (Server Action, params Zod-validated) → `exports` row (`status='queued'`) → `exports.generate` worker (`../30-modules/39-background-jobs.md`; per-tenant flow-control key) streams CSV to `exports` bucket (`storage_path`) → `status='succeeded'` → notification `export_ready` → download via signed URL (TTL 1h per `../10-architecture/15-security.md`); files purged after 7 days by `cleanup.exports` (39) — the UI shows "expires {date}" and re-runs regenerate. Failures: `status='failed'` + `error`, retry button. Requesters see their own exports (RLS); admins see all.

## 10. Audit log viewer (`/admin/audit`) [MVP]

- Filters: `actor_id` (person picker), `actor_kind`, `business_id`, `entity_type` + `entity_id`, `action` (typeahead over the `src/lib/audit/actions.ts` registry), date range, `request_id` exact. Backed by `audit_biz_idx` / `audit_entity_idx` / `audit_actor_idx` — the UI requires at least one indexed filter before querying (no full scans).
- Row expand: side-by-side `before`/`after` JSONB diff (added/removed/changed keys highlighted; PII-minimized at write time per 15), `reason`, `ip`, `user_agent`, `request_id` (deep link to Sentry/OTel trace).
- Insert-only table; the viewer has no mutation affordances. Owner-facing tenant-scoped view of the same data ships in the business portal (`../30-modules/32-business-portal.md` §7.4).

## 11. Admin security posture

- No shared accounts — each operator has their own `platform_admins` row; break-glass service-role use is documented + audited (15).
- MFA (TOTP) mandatory [V1] (`mfa_enforced`); admin logins audited (`auth.login_admin`).
- Reason-required pattern: any write touching tenant/user data blocks submission until a reason is entered; reason lands in `audit_logs.reason`.
- Admin API rate limit 300/min (13); all admin routes `private, no-store`.
- Matrix compliance: `support` never mutates; only `super_admin` touches admins + flags; admin may **pause** campaigns for policy violations (matrix 🟡⁴) via business detail — never activate.

### Error codes registered by this module
| HTTP | Code | Where |
|---|---|---|
| 409 | `VERIFICATION_INVALID_STATE` | decision on non-pending round |
| 422 | `DECISION_REASON_REQUIRED` | reject/revision without reason |
| 422 | `SUSPENSION_REASON_REQUIRED` | suspend without reason |
| 409 | `LAST_SUPER_ADMIN` | demoting/deactivating final super_admin |

### Notification triggers emitted
`verification_decision` (approve/reject/revision), `export_ready`, suspension notice email (transactional, outside marketing gates). Kinds registered in `../30-modules/30-platform-core.md` §5.3.

## Schema deltas proposed

Ratified into `../20-data/26-schema-amendments.md`.

1. `business_verifications.submitted_round` — **DEFERRED**: derivation by counting prior rows is cheap at admin-queue volumes (A21.5).
2. `moderation_requests` table (support suspension requests §4.3 [V1]) — **DEFERRED** to V1 planning; `audit_logs` action `suspension.requested` suffices meanwhile (26 decision summary).
