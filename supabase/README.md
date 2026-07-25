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
surfaces.

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

## Known limitations (tracked)

- `private.jwt_biz_role()` keeps doc 12's table-lookup fallback for `biz_overflow` users (>20 memberships). Under RLS this recurses (policy -> helper -> same table) and Postgres aborts the query for those users. [SCALE]-only surface; fixing requires a security definer lookup variant and an ADR against the Locked doc 12. Do not ship overflow accounts before that ADR.
- The custom access token hook runs as `supabase_auth_admin` with explicit grants/policies (current Supabase-documented pattern) instead of doc 12's literal `security definer` wording. Functionally equivalent; noted as doc drift.
- Column-granularity gaps (follow-up migration owed before these columns become load-bearing): self-update policies do not column-restrict, so today a user could clear their own `is_suspended` / `scan_blocked_until` or write `lifetime_points_earned`; owner updates could touch `businesses.status` / `verified_at` / `plan`; `business_customers` staff updates can write balance columns (service-layer enforced for now); roster reads expose `invite_token` (must be column-restricted before the invites module ships).
- Policy deviation vs doc 21 (record in doc 26 next docs pass): `business_verifications` / `business_documents` are staff READ-only with service-role writes (doc 21 said owner insert/read); tightened deliberately for TIN-adjacent data.

## Advisor acceptances (2026-07-25)

- WARN function_search_path_mutable on the three claim helpers: accepted. Every object reference inside them is schema-qualified, and pinning search_path would block SQL-function inlining that doc 12 requires for RLS hot paths.
- WARN authenticated-callable SECURITY DEFINER public.register_business: accepted, it is the designed tenant-registration entry point (doc 12 tenant lifecycle).
- Legacy note: the wiped pre-existing app left an on_auth_user_created trigger on auth.users; 0003 drops and replaces it.
- Migration 0007 (catalog domain) added: no new ERROR advisors.

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
| 0016_claim_expiry_sweep.sql | (applied 2026-07-25) | 0016_claim_expiry_sweep |

Notes:
- `0000a`/`0000b` are historical one-time cleanups of an unrelated app that
  already occupied this Supabase project. They are `if exists` no-ops on a
  fresh database.
- `0011b` is deliberately a no-op file: the policy conversion it applied live
  is contained in the amended `0011` for fresh replays. It exists only to keep
  the file set and the ledger aligned.
- **Before adopting the Supabase CLI** (`supabase db push` / `migration list`),
  rename these files to the timestamp form `<version>_<name>.sql` using the
  table above, so the CLI recognises them as already applied. Skipping that
  rename makes the CLI try to re-apply everything.
