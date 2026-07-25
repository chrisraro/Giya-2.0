# Supabase database assets

SQL for the Giya database lives here. Migrations are plain SQL files, ordered
by numeric prefix, and each file is applyable top to bottom in a single pass.

```
supabase/
  migrations/
    0001_foundations.sql    extensions, private schema, UUIDv7, claim helpers
    0002_identity.sql       identity tables, RLS policies, ref-table seeds
    0003_auth_plumbing.sql  signup trigger, register_business RPC, JWT hook
    0004_business_staff_self_select.sql   read own memberships without claims
    0005_businesses_staff_table_select.sql  staff table-truth read (superseded)
    0006_fix_businesses_staff_table_select.sql  scope-qualification fix of 0005
    0007_catalog.sql        menu_categories, products, product_variants, product_addons
  tests/
    rls_identity_smoke.sql  pgTAP smoke suite (transaction-wrapped, rolls back)
    ... one suite per domain; see "Running the pgTAP suite" below
```

The directory listing above is abridged; see "Migration ledger" at the end of
this file for the complete file set and how it maps onto the live migration
history (including the pre-0001 legacy-cleanup entries).

## How migrations are applied

- **Now (MVP bootstrap):** applied to the hosted project via the Supabase MCP
  `apply_migration` tool, one file at a time, in numeric order. The files here
  are the source of truth; nothing is written to the database that is not in
  this directory.
- **Later (CLI/CI):** the same files migrate into the Supabase CLI workflow
  (`supabase db push` / `supabase migration up`) and a CI job that applies
  pending migrations on merge to `main`. File naming stays compatible: the CLI
  accepts the `NNNN_name.sql` prefix ordering used here.

## Manual dashboard step: enable the token hook (recommended fast path)

Migration 0003 creates `private.custom_access_token_hook`, but Supabase only
runs it after it is enabled in the dashboard:

1. Open the project dashboard.
2. Go to **Authentication -> Hooks (Beta)**.
3. Under **"Customize Access Token (JWT) Claims hook"**, select
   **`private.custom_access_token_hook`**.
4. Click **Enable**.

Since 0004-0006, core reads no longer depend on the hook: users always read
their own memberships (0004) and staff read their businesses through a table
check (0006), and the portal layout enforces membership from the table, not
claims. The hook remains the fast path and is still REQUIRED for the
claims-only surfaces: `business_verifications` / `business_documents` staff
reads, staff updates on `businesses` / `business_customers`, roster reads
beyond your own row, and admin policies. Enable it before shipping those
surfaces. The admin fraud/receipt-review queue (doc 31) and the admin read on
`audit_logs` are both blocked on this: a claim-based admin policy would
evaluate null for every session today and silently deny.

After changing hook configuration, existing sessions keep their old claims
until the next token refresh (up to 1 hour); sign out and back in to see new
claims immediately.

## Dev note: disable email confirmation (local/dev projects only)

For fast dev signups without a mailbox loop:

1. Open the project dashboard.
2. Go to **Authentication -> Sign In / Up -> Email**.
3. Toggle **"Confirm email"** off.

Leave confirmation ON for the production project.

## Running the pgTAP suite

`0001_foundations.sql` installs pgTAP into the `extensions` schema. The suite
is transaction-wrapped (`begin ... rollback`) and leaves no data behind:

```sh
psql "$DATABASE_URL" -f supabase/tests/rls_identity_smoke.sql
```

Nine suites, one per domain:

| file | covers |
|---|---|
| `rls_identity_smoke.sql` | identity tables and their policies (0001-0006, 0011) |
| `rls_catalog_smoke.sql` | catalog tenancy and composite FKs (0007-0010) |
| `rls_campaigns_smoke.sql` | campaigns, points rules, ledger immutability (0012) |
| `rpc_claim_smoke.sql` | `claim_reward`, `validate_redemption`, `expire_claims` (0013, 0016) |
| `rls_receipts_smoke.sql` | receipts evidence fences, column grant, the three unique amendments, the delete and immutability triggers (0017) |
| `rpc_award_smoke.sql` | `award_receipt_points`: guard order, one earn per receipt, the `balance_after` chain, the Manila-day visit rule (0018) |
| `rls_consumer_fence_smoke.sql` | the `consumers` / `profiles` self-update column fence: legitimate profile and onboarding writes still land, fraud and trust columns raise 42501 (0021) |
| `rls_audit_logs_smoke.sql` | `audit_logs`: the owner-only tenant read and the manager narrowing, platform-level rows (null `business_id`) invisible to every tenant, the `ip` / `user_agent` column fence, client writes refused at the privilege layer, the append-only row trigger and the no-truncate statement trigger, the service_role split (INSERT stays, everything else revoked), and the `action` / `entity_type` shape constraints plus the mandatory admin reason (0022) |
| `rpc_record_visit_smoke.sql` | `record_receipt_visit`: guard order, the doc 40 Asia/Manila visit rule including the UTC/Manila date-boundary case and backdated receipts, spend accumulation, the points columns left untouched, idempotency of a second call, the service_role-only grant, and the interaction with the award path (an award after a recorded visit mints points without adding the same receipt's spend twice) (0023) |

Each suite states the migration range it needs in its header. New suites take
their fixture ids from insert-returning CTEs rather than looking rows up by
name: a name lookup collides with live data on a shared project, which is how
`rpc_claim_smoke.sql` broke on a real `Free Milk Tea` row before it was
rewritten.

Run it as a privileged role (`postgres`); the suite switches to
`authenticated` / `anon` with `set local role` plus `request.jwt.claims` to
simulate end users. Via MCP, the file body can be run with `execute_sql`
(it manages its own transaction).

## Conventions enforced in these files

- Every table enables RLS immediately after creation; deny-all tables carry a
  comment explaining why they have no policies.
- Every `security definer` function pins `set search_path = ''` and fully
  qualifies object references.
- Policies cite their pattern (P1-P4 per `docs/10-architecture/12-multi-tenancy-rls.md`).
- Deviations from the schema docs are marked with `-- amendment:` comments.
- Seeds are idempotent (`on conflict do nothing`) keyed on stable natural keys.

## Storage buckets

Buckets are created from migrations, not the dashboard, so the bucket settings
and their `storage.objects` policies live in the same reviewable file.

### `receipts` (0019_receipts_storage.sql)

| property | value |
|---|---|
| `public` | `false` |
| `file_size_limit` | `10485760` (10MB, the hard cap in `docs/10-architecture/15-security.md`) |
| `allowed_mime_types` | `image/jpeg`, `image/png`, `image/webp` |
| path convention | `receipts/{user_id}/{uuid}.jpg` (`docs/30-modules/36-receipt-ocr-pipeline.md` Stage 1) |

The object `name` inside the bucket is `{user_id}/{uuid}.jpg`, so the first path
segment is the owning consumer's auth uid. Both policies fence on exactly that,
via `(storage.foldername(name))[1] = (select auth.uid())::text`:

- `receipts_objects_consumer_insert` (INSERT, `authenticated`) - a consumer may
  only write under their own uid prefix, and only one level deep.
- `receipts_objects_consumer_select` (SELECT, `authenticated`) - a consumer may
  only read their own objects.

**Private, not public.** Receipt images carry merchant, date, line items and
total. Doc 15 lists `receipts` among the private buckets; access is via signed
URLs with a 5 minute TTL, generated server-side. The OCR pipeline and the
business/admin review UI read through the service role, which bypasses RLS -
there is deliberately no staff policy on `storage.objects`, so staff have no
direct-client path to receipt images at all.

**No UPDATE policy and no DELETE policy, deliberately.** Receipt images are
evidence. An UPDATE policy would let a consumer swap the bytes out from under a
receipt row whose `sha256` and pHash were computed from the original, leaving an
approved and awarded receipt pointing at different pixels than the ones the
duplicate and fraud checks saw. A DELETE policy would let a consumer destroy the
image behind an approved award, or behind a fraud rejection whose
`fraud_signals` rows feed doc 37's cooldown ladder, while the `receipts` row
itself cannot be deleted (the `receipts_no_delete` trigger in 0017). The one
legitimate mutation, the sharp canonicalization overwrite that strips EXIF/GPS
at ingest, runs with the service role and needs no policy. Storage adds a
`protect_delete` trigger of its own, so a direct SQL `DELETE` against
`storage.objects` fails for every role regardless.

Note that `file_size_limit` and `allowed_mime_types` are enforced by the Storage
API, not by Postgres. The submit path re-checks the 10MB cap and magic-byte
sniffs the content type server-side; the bucket settings are a second fence, not
the only one.

## Known limitations (tracked)

- `private.jwt_biz_role()` keeps doc 12's table-lookup fallback for `biz_overflow` users (>20 memberships). Under RLS this recurses (policy -> helper -> same table) and Postgres aborts the query for those users. [SCALE]-only surface; fixing requires a security definer lookup variant and an ADR against the Locked doc 12. Do not ship overflow accounts before that ADR.
- The custom access token hook runs as `supabase_auth_admin` with explicit grants/policies (current Supabase-documented pattern) instead of doc 12's literal `security definer` wording. Functionally equivalent; noted as doc drift.
- ~~**`consumers.scan_blocked_until` is now load-bearing and still self-writable.**~~ **CLOSED by `0021_consumer_selfupdate_column_fence.sql`.** `consumers_owner_update` and `profiles_owner_update` are still row-scoped only (RLS cannot express column grants), but `authenticated` no longer holds table-level UPDATE on either table. It now holds UPDATE on exactly these columns, and nothing else:
  - `public.consumers`: `city_id`, `marketing_opt_in`, `push_enabled`, `email_enabled`, `gps_fraud_opt_in`, `updated_by`.
  - `public.profiles`: `display_name`, `avatar_url`, `phone`, `locale`, `onboarded_at`, `updated_by`.

  So `consumers.scan_blocked_until` (doc 37 ladder step 2) and `profiles.is_suspended` / `suspended_reason` (ladder step 4) are no longer self-clearable, and neither are `lifetime_points_earned`, `last_scan_at`, `referral_code`, `referred_by`, `deleted_at`, or the A21.1 `birth_date` / `birth_date_updated_at` pair (fenced together: granting the value without its once-per-rolling-year enforcement column, or vice versa, defeats the rule either way, and nothing writes them yet). Covered by `rls_consumer_fence_smoke.sql`. The `authenticated` allowlists are asserted there as exact sorted strings, so adding a column to either table without deciding whether it is self-writable fails the suite.
- Column-granularity gaps that REMAIN (follow-up migration owed before these columns become load-bearing): owner updates could touch `businesses.status` / `verified_at` / `plan`; `business_customers` staff updates can write `segment` and `notes` only since 0013, but the `businesses` surface has no equivalent fence yet; roster reads expose `invite_token` (must be column-restricted before the invites module ships). Deliberately not fenced in 0021 because they are staff/tenant surfaces rather than the consumer self-update surface this slice made load-bearing, and `businesses.status` in particular needs the verification state machine settled first.
- Policy deviation vs doc 21 (record in doc 26 next docs pass): `business_verifications` / `business_documents` are staff READ-only with service-role writes (doc 21 said owner insert/read); tightened deliberately for TIN-adjacent data.
- **`audit_logs` reads are OWNER-only; a manager cannot read them at all.** This will surprise someone, because every neighbouring table in the receipts domain (`receipts`, `fraud_signals`, `ai_usage_events`) settled on `array['owner','manager']`, and a manager is precisely the person who decides the receipts this table records. That is the reason, not an oversight: doc 01's permission matrix has "View audit logs (own tenant)" as the one row in the Platform block where owner is ticked and manager is not, and an audience that can read the file kept on itself is doc 15's threat-model item 6 (insider abuse). Owner is the only business role accountable for the tenant. Asserted in `rls_audit_logs_smoke.sql`, so widening it fails the suite rather than passing quietly. Two related consequences of the same policy: rows with a null `business_id` (admin and system actions) are visible to NO tenant and are read through the service role until the token hook lands, and `ip` / `user_agent` are revoked from `authenticated` entirely, so `select *` on `audit_logs` raises 42501 and client reads must name their columns.
- No admin policy on `audit_logs`, against doc 25's "select admin; select owner where business_id matches". Same call 0017 made for `receipts` and `fraud_signals`: every admin predicate reads the platform-admin claim and the custom access token hook is not enabled on this project, so a claim-based admin policy would evaluate null for every session and silently deny. Admin audit surfaces read via the service role until the hook is enabled.

## Advisor acceptances (2026-07-25)

- WARN function_search_path_mutable on the three claim helpers: accepted. Every object reference inside them is schema-qualified, and pinning search_path would block SQL-function inlining that doc 12 requires for RLS hot paths.
- WARN authenticated-callable SECURITY DEFINER public.register_business: accepted, it is the designed tenant-registration entry point (doc 12 tenant lifecycle).
- Legacy note: the wiped pre-existing app left an on_auth_user_created trigger on auth.users; 0003 drops and replaces it.
- Migration 0007 (catalog domain) added: no new ERROR advisors.
- Migrations 0017-0020 (receipts domain, `award_receipt_points`, the storage
  bucket, Realtime) added: no new advisors of any level. The security set is
  still 0 ERROR and 7 WARN, being the three claim-helper search_path warnings,
  three authenticated-callable SECURITY DEFINER functions
  (`register_business`, `claim_reward`, `validate_redemption`) and the
  leaked-password toggle below. `award_receipt_points` is absent from that
  definer list because EXECUTE is granted to `service_role` only, and
  `private.manila_day` pins `search_path = ''`.
- Migrations 0021-0023 (`consumers`/`profiles` column fence, `audit_logs`,
  `record_receipt_visit`) added: no new advisors of any level. Verified live on
  2026-07-25 after 0023: still 0 ERROR and the same 7 WARN. `record_receipt_visit`
  and `private.apply_receipt_visit` are absent from the definer list because
  EXECUTE on the first is granted to `service_role` only and revoked from every
  role on the second, and both pin `search_path = ''`.

## Manual dashboard steps (pending)

- Enable leaked-password protection: Authentication -> Providers -> Email -> enable 'Leaked password protection' (advisor auth_leaked_password_protection; doc 15 requires it for production).

## Migration ledger (files vs live)

The committed files map 1:1 onto the live `supabase_migrations.schema_migrations`
ledger. Live versions are timestamps; the files use readable ordinal prefixes:

| file | live version | live name |
|---|---|---|
| 0000a_drop_legacy_licenses_payments.sql | 20260724180330 | drop_legacy_licenses_payments |
| 0000b_drop_legacy_profiles_flags_feedback.sql | 20260724180338 | drop_legacy_profiles_flags_feedback |
| 0001_foundations.sql | 20260724180457 | 0001_foundations |
| 0002_identity.sql | 20260724180622 | 0002_identity |
| 0003_auth_plumbing.sql | 20260724180740 | 0003_auth_plumbing |
| 0004_business_staff_self_select.sql | 20260724190529 | 0004_business_staff_self_select |
| 0005_businesses_staff_table_select.sql | 20260724191136 | 0005_businesses_staff_table_select |
| 0006_fix_businesses_staff_table_select.sql | 20260724191228 | 0006_fix_businesses_staff_table_select |
| 0007_catalog.sql | 20260725012057 | 0007_catalog |
| 0008_catalog_composite_fks.sql | 20260725014424 | 0008_catalog_composite_fks |
| 0009_fix_category_fk_set_null_column.sql | 20260725020639 | 0009_fix_category_fk_set_null_column |
| 0010_catalog_table_staff_policies.sql | 20260725023446 | 0010_catalog_table_staff_policies |
| 0011_identity_table_staff_policies.sql | 20260725024946 | 0011_identity_table_staff_policies |
| 0011b_business_food_types_table_staff.sql | 20260725025010 | 0011b_business_food_types_table_staff |
| 0012_campaigns.sql | 20260725035425 | 0012_campaigns |
| 0013_reward_claim_rpcs.sql | 20260725055852 | 0013_reward_claim_rpcs |
| 0014_realtime_reward_claims.sql | 20260725070033 | 0014_realtime_reward_claims |
| 0015_campaign_budget_lock.sql | 20260725073038 | 0015_campaign_budget_lock |
| 0016_claim_expiry_sweep.sql | 20260725082951 | 0016_claim_expiry_sweep |
| 0017_receipts.sql | 20260725111658 | 0017_receipts |
| 0018_award_receipt_points.sql | 20260725114121 | 0018_award_receipt_points |
| 0019_receipts_storage.sql | 20260725113309 | 0019_receipts_storage |
| 0020_realtime_receipts.sql | 20260725123010 | realtime_receipts |
| 0021_consumer_selfupdate_column_fence.sql | 20260725131247 | 0021_consumer_selfupdate_column_fence |
| 0022_audit_logs.sql | 20260725141733 | 0022_audit_logs |
| 0023_record_receipt_visit.sql | 20260725143104 | 0023_record_receipt_visit |

Notes:
- **0020's live ledger name is `realtime_receipts`, without the ordinal
  prefix**, unlike every row above it. Recorded rather than corrected: the
  ledger name is what `supabase migration list` matches on, so editing it after
  the fact would make the CLI believe the migration had never been applied. The
  file keeps the `0020_` prefix for authoring order.
- **0020 makes `receipts` a Realtime table.** Before it, the `supabase_realtime`
  publication contained only `reward_claims` (added by 0014), so
  `postgres_changes` subscriptions on `receipts` subscribed cleanly and then
  never fired. Both Realtime tables now carry `replica identity full`. WALRUS
  applies 0017's column-level grant to the payload, so a consumer still receives
  only the 13 granted columns of their own rows.
- `0000a`/`0000b` are historical one-time cleanups of an unrelated app that
  already occupied this Supabase project. They are `if exists` no-ops on a
  fresh database.
- `0011b` is deliberately a no-op file: the policy conversion it applied live
  is contained in the amended `0011` for fresh replays. It exists only to keep
  the file set and the ledger aligned.
- **0018 and 0019 are inverted in the live ledger.** 0019 was applied at
  `20260725113309` and 0018 at `20260725114121`, because the two were authored
  in parallel and the storage migration finished first. They are independent
  (0019 creates a storage bucket and its policies; 0018 creates an RPC over
  tables that 0017 already created), so neither ordering changes the result and
  nothing needs re-applying. It matters only for the rename below: renaming to
  timestamp form makes 0019 sort BEFORE 0018, which is correct for the CLI and
  deliberately disagrees with the ordinal prefixes. Do not "fix" the ordinals
  to match; the ordinals record authoring order and the timestamps record
  application order.
- **Before adopting the Supabase CLI** (`supabase db push` / `migration list`),
  rename these files to the timestamp form `<version>_<name>.sql` using the
  table above, so the CLI recognises them as already applied. Skipping that
  rename makes the CLI try to re-apply everything.
