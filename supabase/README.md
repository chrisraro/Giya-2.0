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

## Token hook: ENABLED as of 2026-07-26

**The custom access token hook is now live** on `zlfxfzlnklqhajacngxf`, set via the
Management API rather than the dashboard:
`hook_custom_access_token_enabled = true`,
`hook_custom_access_token_uri = pg-functions://postgres/private/custom_access_token_hook`.

Verified by a real auth round trip: sign-in succeeds and the issued token carries
`app_metadata.biz` with the caller's business memberships. Nothing regressed,
because every policy already used the table-truth helper and the hook is purely
additive: it is a fast path and now also unblocks the claim-only admin surfaces
(doc 31's fraud queue, the `audit_logs` admin read).

Note `password_hibp_enabled` could NOT be enabled: leaked-password protection is
a **Pro plan** feature. That is the real reason, not the missing email provider
recorded earlier.

### Historical: the original manual instructions

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
reads, staff updates on `businesses` / `business_customers`, and roster reads
beyond your own row. Enable it before shipping those surfaces.

The admin half is no longer pending: **0031 landed the admin policies** that
0017 and 0022 deferred (`receipts`, `receipt_line_items`, `ocr_results`,
`fraud_signals`, `ai_usage_events`, platform-scope `settings`, `audit_logs`),
seeded the first `platform_admins` row, and added the clawback RPC. Verified by
`rls_admin_smoke.sql`. Note what that did NOT change: an admin is still the
`authenticated` role, so the column-level grants on `receipts` and `audit_logs`
withhold the same columns from an admin as from anyone else, and the admin
portal reads those through the service role exactly as the business review
queue does.

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

Fifteen suites, one per domain:

| file | covers |
|---|---|
| `rls_identity_smoke.sql` | identity tables and their policies (0001-0006, 0011) |
| `rls_catalog_smoke.sql` | catalog tenancy and composite FKs (0007-0010) |
| `rls_campaigns_smoke.sql` | campaigns, points rules, ledger immutability (0012) |
| `rpc_claim_smoke.sql` | `claim_reward`, `validate_redemption`, `expire_claims` (0013, 0016) |
| `rls_receipts_smoke.sql` | receipts evidence fences, column grant, the three unique amendments, the delete and immutability triggers (0017) |
| `rpc_award_smoke.sql` | `award_receipt_points`: guard order, one earn per receipt, the `balance_after` chain, the Manila-day visit rule (0018); the `fixed_per_visit` VISIT-DAY dedupe and its `FIXED_PER_VISIT_RACE` backstop, keyed on `manila_day(coalesce(receipt_date, created_at))` rather than processing time, including the review-lag/backdated-upload cases and the two I3 cases where a prior earn that was not itself a PAID fixed_per_visit base must not suppress a later one (0037, 0038) |
| `rls_consumer_fence_smoke.sql` | the `consumers` / `profiles` self-update column fence: legitimate profile and onboarding writes still land, fraud and trust columns raise 42501 (0021) |
| `rls_audit_logs_smoke.sql` | `audit_logs`: the owner-only tenant read and the manager narrowing, platform-level rows (null `business_id`) invisible to every tenant, the `ip` / `user_agent` column fence, client writes refused at the privilege layer, the append-only row trigger and the no-truncate statement trigger, the service_role split (INSERT stays, everything else revoked), and the `action` / `entity_type` shape constraints plus the mandatory admin reason (0022) |
| `rpc_record_visit_smoke.sql` | `record_receipt_visit`: guard order, the doc 40 Asia/Manila visit rule including the UTC/Manila date-boundary case and backdated receipts, spend accumulation, the points columns left untouched, idempotency of a second call, the service_role-only grant, and the interaction with the award path (an award after a recorded visit mints points without adding the same receipt's spend twice) (0023) |
| `rls_template_embedding_smoke.sql` | pgvector template embeddings: the pinned vector(384) width enforced rather than decorative, cosine ordering, and that RLS still applies to a vector query (0024) |
| `rls_notifications_smoke.sql` | `notifications`: recipient-only reads, the read_at column grant, and the narrow trigger that permits marking read while refusing a body edit (0026) |
| `ref_data_smoke.sql` | reference data: both tables non-empty, the seed idempotent on replay, every city carrying a non-null province and region in one of the 18 real regions (0027) |
| `rls_admin_smoke.sql` | the admin surface (0031): every admin SELECT policy 0017 and 0022 deferred, asserted as a PAIR (an admin session reads another tenant's fraud signals, receipts, line items, OCR evidence, AI spend, audit rows and platform settings; a non-admin owner of a real tenant reads none of them and still reads their own), the unmatched receipt (`business_id` null) that 0017 noted no audience could see, the column fences that an admin policy deliberately does NOT widen (`receipts.parse_meta`, `audit_logs.ip`), and `clawback_receipt_points`: the service_role-only grant, the mandatory reason, table-truth actor verification (a `support` admin is refused), `CLAWBACK_INVALID_STATE` for a receipt with no earn row and for a second attempt, the negative ledger row with `reverses_id` and its `balance_after` under the pair lock, the receipt landing on `rejected`/`fraud_suspected` with `reviewed_by`, the in-transaction audit row, and doc 35's clamping with the residual recorded as `after.shortfall_points` |
| `rpc_sweeps_smoke.sql` | the two scheduled sweeps: `sweep_stuck_receipts` moves a stuck, out-of-budget receipt to `review` with `reject_reason` null, the note `ocr_operator_failure:sweep` and `parse_meta.review_reasons = ["ocr_operator_failure"]` (**changed by 0035, decision D7** - every receipt this sweep can see is one WE failed to process, because an unreadable IMAGE is finalized on the attempt that discovered it, so the old `rejected` / `manual` / `processing_failed` told a paying customer their photograph was the defect when the likeliest cause was an exhausted Vision quota), while a receipt with a NULL `business_id` is still dead-lettered because 0017 gives no RLS audience a path to it, and both a receipt still inside its attempt budget and a receipt that is merely recent are left completely untouched, the business-scope `ocr.max_attempts` override widens the budget and withdrawing it narrows it again, a second run is a no-op, no ledger row is written, both `cron.job` rows carry the expected schedule and command, `expire_claims` still runs clean, and every function is service_role only (0028, 0035) |
| `rpc_activation_smoke.sql` | merchant activation (0033), 52 assertions: THE COLUMN FENCE ON `businesses` asserted both ways (an owner's session with a real `biz` claim gets 42501 writing `status`, `verified_at` or `plan`, and the same session still edits `name` and the edit lands, so the refusals are about COLUMNS and not about a policy that missed), `private.has_usable_base_rule` including the half-filled `amount_rate` row with a null rate that passes every table constraint and awards nothing, the service_role-only grant on all three RPCs, `submit_business_for_review` (owner-only by table truth, refused for a tenant with no usable rule, opens a `business_verifications` round, writes an `actor_kind='user'` audit row, and refuses a second submission), `activate_business` (mandatory reason, `support` refused, the tenant's own owner refused, ACTIVATION_NO_EARNING_RULE when the rule is deleted between submission and decision with nothing written by the refusal, then success stamping `verified_at`, closing the round as approved with `decided_by`, and writing an `actor_kind='admin'` audit row carrying the reason), `reject_business_verification` (back to draft, round closed as rejected, and the merchant reading `decision_reason` UNDER THEIR OWN SESSION), and 0033's two admin SELECT policies as a pair |
| `rls_integration_connections_smoke.sql` | `integration_connections` (0032): THE TOKEN COLUMN FENCE, asserted as the pair that matters (an owner reading their OWN tenant row gets 42501 on `access_token_encrypted` and `refresh_token_encrypted`, and on `select *`, while every allowlisted column reads cleanly), the owner/manager role list and the marketing narrowing, cross-tenant denial, the consumer and anon matrix rows, no client write path of any kind, the service_role split (insert/update/delete stay, TRUNCATE goes), the no-truncate statement trigger, and the four check constraints: the plaintext envelope fence (a raw `EAAG...` token is refused because its first byte is not the envelope version), the error/status pairing in both directions, and the provider and status vocabularies, plus the account uniqueness rule that reconnect upserts onto |
| `rpc_routing_breakdown_smoke.sql` | `receipt_routing_breakdown` (0035, decision D10), 14 assertions over two tenants: the four outcome buckets with queued/processing collapsing to `pending`, attribution counted once per receipt including a receipt that tripped two rules (so the reason counts exceed the review count, which is correct rather than a rounding error), D7's `ocr_operator_failure` attributed like any other reason, BACKFILL HONESTY (a review whose `parse_meta` predates `review_reasons` counts as `unattributed` and never inflates a real rule), TENANCY asserted as the pair that matters (one tenant's breakdown never carries the other's reason, and the platform-scoped `p_business_id null` call does see both), the `p_days` window filter and its clamp, and the service_role-only grant that keeps an aggregate from routing around 0017's `parse_meta` column fence |
| `rpc_points_expiry_smoke.sql` | Task 1.3 points expiry enforcement (0042-0044), 37 assertions: doc 35 section 7's FIFO remainder formula at two granularities (`private.points_lot_remainders` per-lot, `private.points_expirable_remainder` aggregate) - a partially-consumed lot, a later untouched lot, a lot fully drained to 0, and a clawback-only consumption (no redeem) all matching hand-computed vectors; `public.points_next_expiry` (the wallet's shared read) correctly excluding an already-past-due lot; `public.expire_points` (the sweep) writing the right `expire` row, keeping the cached balance equal to the ledger sum, touching nothing for a zero-balance pair, and a second run expiring nothing more (idempotent); `public.points_expiry_warn` (the warn job) firing the 30d horizon alone for a 20-day-out lot, both the 30d AND 7d horizons in one run for a 5-day-out lot, the in_app/email channel split (`sent`/`pending`), and a second run raising nothing new (dedupe, keyed on lot `expires_at` cast back to `timestamptz` rather than compared as text - see 0044's header on why a text comparison against jsonb's ISO-8601 serialization never matches); both `cron.job` rows with their exact schedule and command; and the full I-A grant matrix (service_role only on every new `public.` surface, not even service_role on either `private.` helper) |

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

## Scheduled jobs (pg_cron)

`0028_scheduled_sweeps.sql` installs `pg_cron` and schedules the two sweeps that
had been correct and unreachable since they were written. There are no QStash
credentials on this project, so the scheduler is Postgres itself.

`pg_cron` is not relocatable (its control file pins `schema = pg_catalog`), so
it is the one extension that cannot follow `0001_foundations.sql`'s
`with schema extensions` convention. It creates its own `cron` schema. No app
role holds `usage` on that schema, deliberately: `cron.job` exposes the whole
schedule and `cron.job_run_details` exposes every error string a sweep has ever
raised.

| job | cron (UTC) | calls | why this cadence |
|---|---|---|---|
| `claims.expiry_sweep` | `7 * * * *` | `public.expire_claims(200)` | Doc 39's registered offset for this queue. `rewards.claim_expiry_days` is 1 to 365 (default 30), so the shortest TTL the schema permits is 24h; hourly holds a lapsed claim's inventory and points for at most 1/24 of that, and about 1/720 of the default. More often multiplies scans for a sub-hour gain; daily would, on a 1-day TTL, lock inventory for as long again as the claim was valid. |
| `receipts.stuck_sweep` | `50 * * * *` | `public.sweep_stuck_receipts(200)` | :50 is doc 39's hourly jobs-reconciler slot, which is what this is. Against a 24h threshold, 23 runs in 24 find nothing and each empty run is one partial-index probe. The payoff is bounded discovery latency: a receipt reaches the operator's queue within the hour of crossing the threshold rather than within a day. |
| `points.expiry_sweep` | `10 18 * * *` | `public.expire_points(200)` | Doc 39's registered slot (02:10 Manila), right after the daily rollup (01:40). Points expire on a flat 12-month clock (0042), so a day's latency on the sweep is negligible against that TTL - daily is the doc-registered cadence and there is no tighter invariant to protect the way claims' sub-day TTL argues for hourly. |
| `points.expiry_warn` | `25 18 * * *` | `public.points_expiry_warn(200)` | Doc 39's registered slot (02:25 Manila), immediately after the expiry sweep itself, so a lot the sweep just expired can never also be warned about in the same run. |

All four jobs run as `postgres`, which owns every function and so retains
EXECUTE independently of the `service_role`-only grants. All four functions
are idempotent (`points.expiry_sweep`/`points.expiry_warn` by recomputing the
same FIFO formula from the ledger each run - see `rpc_points_expiry_smoke.sql`
- the other two via `for update skip locked`), so an overlapping run or a
concurrent application write is safe.

### Points expiry (0042-0044, task 1.3)

The 12-month rolling expiry published in the consumer terms and on the
wallet is enforced by three pieces, all sharing ONE FIFO formula
(`private.points_lot_remainders`, doc 35 section 7):

- **Stamping** (0042): `award_receipt_points` now stamps every positive earn
  row `expires_at = now() + interval '12 months'` itself (a caller-supplied
  `p_expires_at` still overrides it, but no caller sends one today) - the
  single earn-writer chokepoint, so no future writer can forget it. The
  migration also backfills the earn row(s) that predate it, which required
  briefly disabling `points_transactions`' append-only trigger for exactly
  one `UPDATE` statement (see the migration header for why that is a
  deliberate, reviewed exception and not a precedent).
- **The sweep** (`public.expire_points`, 0043): writes one `expire` ledger row
  per (business, consumer) pair whose past-due lots still have a positive
  FIFO remainder, floored at 0, never driving the balance negative.
- **The warn job** (`public.points_expiry_warn`, 0044): raises
  `kind='points_expiring'` at the 30-day and 7-day horizons before a lot
  expires, deduped per (pair, lot, horizon) via the notification's own `data`
  payload. It writes directly into `public.notifications` rather than calling
  `src/features/notifications/server/raise.ts`, because pg_cron cannot reach
  TypeScript - the `in_app` row is a complete delivery, the `email` row is
  durable but unsent (nothing enqueues a `notify.email` job for it yet; see
  0044's header for the honest accounting of that gap).

The wallet's own "what expires when" line (`public.points_next_expiry`) reads
the identical formula, so the number a consumer sees is the number the sweep
will eventually take.

### What the receipts sweep does and does not do

It cannot re-run OCR. Every retry decision lives in TypeScript
(`src/features/receipts/server/process.ts`), and reimplementing any of it in
plpgsql would create the second pipeline doc 36 Stage 9 exists to prevent. So
the sweep builds the honest half only: it lands genuinely-dead receipts in doc
36's dead-letter state (`status='rejected'`, `reject_reason='manual'`,
`reject_note='processing_failed'`) where an operator can see them.

Three conditions must ALL hold before a receipt is touched:

1. `status = 'processing'`, re-asserted on the UPDATE so a receipt the pipeline
   finished mid-sweep is left as the pipeline finished it.
2. `updated_at` older than `settings['receipts.stuck_processing_hours']`
   (platform scope, seeded at **24**). On a processing row `updated_at` is when
   the pipeline claimed it, so this is time since last progress. A merely slow
   receipt is never swept.
3. `max(ocr_results.attempt)` at or above the effective `ocr.max_attempts`
   (business scope wins over platform, matching the settings loader). This is
   the same comparison `handleOcrFailure` makes before it writes the same state
   itself, so the sweep can only reach the conclusion the pipeline would have
   reached had it run again.

A receipt with zero recorded attempts is therefore never swept, and neither is
one parked by an `OCR_AUTH_FAILED` / `OCR_MISCONFIGURED` operator failure that
has not burned the budget. Both are deliberate: rejecting a real customer's
genuine purchase cannot be undone by the consumer, and leaving a receipt
processing for another hour costs nothing.

The sweep writes exactly one table. It never touches the points ledger, and it
cannot: a receipt at `processing` has no earn row, because
`award_receipt_points` (0018) only runs after the terminal `approved` write.

### How an operator notices a failed run

`cron.job_run_details` records every run with `status` and `return_message`.
That table carries row level security with the policy `username = current_user`
and no app role holds `usage` on schema `cron`, so it cannot simply be selected
through PostgREST. `public.sweep_job_health(p_hours integer default 24)` is the
read path: `security definer`, owned by `postgres`, granted to `service_role`
only. It returns one row per scheduled job with `runs`, `failures`,
`last_status`, `last_finished_at` and `last_error` (the most recent FAILING
message, not the most recent message, so a job that fails every other run is
still readable).

```sql
-- as postgres, or via the service role
select * from public.sweep_job_health(24);

-- the raw rows, privileged only
select j.jobname, d.status, d.start_time, d.return_message
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
 order by d.start_time desc
 limit 20;
```

An operator query worth running alongside it, since the sweep deliberately
leaves these alone:

```sql
select id, updated_at, now() - updated_at as stuck_for
  from public.receipts
 where status = 'processing'
 order by updated_at;
```

Anything in that list older than a day is a receipt the sweep declined to
declare dead, which is exactly the set a human should look at.

**Not wired yet:** nothing alerts on `failures > 0` and nothing notifies the
consumer when the sweep dead-letters their receipt. The pipeline's own
dead-letter path sends `receipt_rejected` through the TypeScript copy matrix
(`notifyReceiptOutcome`); composing that copy in plpgsql would duplicate it,
which is the thing this migration is at pains not to do. Receipts is in the
Realtime publication (0020) and the consumer's history reads the row, so the
outcome is visible; the push is owed to the notifications slice.

## Known limitations (tracked)

- `private.jwt_biz_role()` keeps doc 12's table-lookup fallback for `biz_overflow` users (>20 memberships). Under RLS this recurses (policy -> helper -> same table) and Postgres aborts the query for those users. [SCALE]-only surface; fixing requires a security definer lookup variant and an ADR against the Locked doc 12. Do not ship overflow accounts before that ADR.
- The custom access token hook runs as `supabase_auth_admin` with explicit grants/policies (current Supabase-documented pattern) instead of doc 12's literal `security definer` wording. Functionally equivalent; noted as doc drift.
- ~~**`consumers.scan_blocked_until` is now load-bearing and still self-writable.**~~ **CLOSED by `0021_consumer_selfupdate_column_fence.sql`.** `consumers_owner_update` and `profiles_owner_update` are still row-scoped only (RLS cannot express column grants), but `authenticated` no longer holds table-level UPDATE on either table. It now holds UPDATE on exactly these columns, and nothing else:
  - `public.consumers`: `city_id`, `marketing_opt_in`, `push_enabled`, `email_enabled`, `gps_fraud_opt_in`, `updated_by`.
  - `public.profiles`: `display_name`, `avatar_url`, `phone`, `locale`, `onboarded_at`, `updated_by`.

  So `consumers.scan_blocked_until` (doc 37 ladder step 2) and `profiles.is_suspended` / `suspended_reason` (ladder step 4) are no longer self-clearable, and neither are `lifetime_points_earned`, `last_scan_at`, `referral_code`, `referred_by`, `deleted_at`, or the A21.1 `birth_date` / `birth_date_updated_at` pair (fenced together: granting the value without its once-per-rolling-year enforcement column, or vice versa, defeats the rule either way, and nothing writes them yet). Covered by `rls_consumer_fence_smoke.sql`. The `authenticated` allowlists are asserted there as exact sorted strings, so adding a column to either table without deciding whether it is self-writable fails the suite.
- ~~**Owner updates could touch `businesses.status` / `verified_at` / `plan`.**~~ **CLOSED by `0033_business_activation.sql`.** 0021 deferred this one explicitly ("`businesses.status` in particular needs the verification state machine settled first"); 0033 settles the state machine and pays the debt in the same file, because everything else in that slice would otherwise be advisory: an owner who can PATCH their own `status` does not need an approval queue. `authenticated` no longer holds table-level UPDATE on `public.businesses`. It now holds UPDATE on exactly these columns, and nothing else: `name`, `description`, `logo_url`, `cover_url`, `gallery`, `phone`, `email`, `website`, `socials`, `address_line`, `barangay`, `city_id`, `postal_code`, `lat`, `lng`, `google_place_id`, `opening_hours`, `business_type_id`, `updated_by`.

  So `status`, `verified_at`, `plan`, `plan_limits` and `suspended_reason` are no longer self-writable, and neither is `slug` (the public identity token in every printed QR link, whose doc 32 section 4 rule of owner-only and once per 30 days no column grant can express, so it is fenced together with its unbuilt enforcement path exactly as 0021 fenced the `birth_date` pair) or `deleted_at`. `src/features/businesses/settings/server/repo.ts` keeps its own `assertEditableColumns` allowlist as the second layer; its header explains that it existed BECAUSE this fence did not, and it is now a belt beside braces rather than the only thing standing in the way. Covered by `rpc_activation_smoke.sql`, which asserts the refusal and the still-permitted profile edit as a pair.
- Column-granularity gaps that REMAIN (follow-up migration owed before these columns become load-bearing): `business_customers` staff updates can write `segment` and `notes` only since 0013; roster reads expose `invite_token` (must be column-restricted before the invites module ships, which is also why 0033 deliberately added NO admin SELECT policy on `business_staff` even though the verification queue names the applicant).
- Policy deviation vs doc 21 (record in doc 26 next docs pass): `business_verifications` / `business_documents` are staff READ-only with service-role writes (doc 21 said owner insert/read); tightened deliberately for TIN-adjacent data.
- **`audit_logs` reads are OWNER-only; a manager cannot read them at all.** This will surprise someone, because every neighbouring table in the receipts domain (`receipts`, `fraud_signals`, `ai_usage_events`) settled on `array['owner','manager']`, and a manager is precisely the person who decides the receipts this table records. That is the reason, not an oversight: doc 01's permission matrix has "View audit logs (own tenant)" as the one row in the Platform block where owner is ticked and manager is not, and an audience that can read the file kept on itself is doc 15's threat-model item 6 (insider abuse). Owner is the only business role accountable for the tenant. Asserted in `rls_audit_logs_smoke.sql`, so widening it fails the suite rather than passing quietly. Two related consequences of the same policy: rows with a null `business_id` (admin and system actions) are visible to NO tenant and are read through the service role until the token hook lands, and `ip` / `user_agent` are revoked from `authenticated` entirely, so `select *` on `audit_logs` raises 42501 and client reads must name their columns.
- No admin policy on `audit_logs`, against doc 25's "select admin; select owner where business_id matches". Same call 0017 made for `receipts` and `fraud_signals`: every admin predicate reads the platform-admin claim and the custom access token hook is not enabled on this project, so a claim-based admin policy would evaluate null for every session and silently deny. Admin audit surfaces read via the service role until the hook is enabled.
- **`points.expiry_warn`'s email row is durable but unsent (0044, task 1.3).** The `in_app` row it writes lands in the recipient's inbox immediately, same as `raise.ts` would produce, but the `email` row it also writes (`status='pending'`) has nothing enqueuing a `notify.email` job for it: pg_cron can only invoke SQL, and a raw `INSERT` into `public.jobs` from plpgsql would bypass `src/lib/queue/enqueue.ts`, the one enqueue path doc 39 names. This mirrors `expire_claims`'s own precedent (0016 shipped the sweep without doc 35's `notify kind='reward_claim_expired'` half at all) but is a narrower gap: the guaranteed channel does land. Follow-up: a worker or reconciler scanning `notifications` rows `channel='email' and status='pending' and kind='points_expiring'` and calling `enqueue()` for them.
- **`award_receipt_points`'s `p_verify_no_prior_fixed_visit_earn` invariant (0037/0038, task 1.1 review I1) is caller-opt-in, unlike every other guard in that function.** Every OTHER ledger invariant in this schema is enforced unconditionally behind the three-layer fence (privilege revocation + row-level lock + explicit guard the RPC always runs). This one cannot be: the RPC has no way to know a receipt's WINNING base rule is `fixed_per_visit` - that resolution (which `points_rules` row wins, campaign stacking, conditions) lives entirely in the pure TypeScript engine (doc 35 section 11's "one implementation of the rule math"), so enforcing it unconditionally in SQL would mean either duplicating rule resolution there or blocking every other rule_type's award on an irrelevant check. The invariant therefore lives in TypeScript (`src/features/receipts/server/award.ts`'s `priceReceipt` decides whether the dedupe applies at all, via the advisory `public.fixed_per_visit_already_paid` read), with `award_receipt_points`'s own re-check under the `business_customers` lock (`private.fixed_per_visit_already_paid`, keyed on VISIT DAY - `manila_day(coalesce(receipts.receipt_date, points_transactions.created_at))`, not processing time) as the race-safe backstop for the one case TypeScript alone cannot close: a concurrent request committing between the precheck and the lock. When that backstop fires (`FIXED_PER_VISIT_RACE`), `awardPoints` recovers in TypeScript by replaying the precomputed deduped total rather than leaving the receipt refused - see the same file's `awardAfterFixedPerVisitRace`. Covered by `rpc_award_smoke.sql`'s fixed_per_visit section (visit-day keying, the review-lag and backdated-upload cases, and the two I3 cases where a prior earn that was NOT itself a paid fixed_per_visit base must not suppress a later one).

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
- Migration 0028 (`pg_cron`, the two scheduled sweeps) added: no new advisors of
  any level. Verified live on 2026-07-26 after 0028: 0 ERROR, and neither
  `sweep_stuck_receipts` nor `sweep_job_health` appears in the definer-callable
  warnings, because EXECUTE on both is granted to `service_role` only and both
  pin `search_path = ''`. The WARN count read 9 rather than the 7 recorded
  above: the two extra entries are both `public.rls_auto_enable`, the
  pre-existing event-trigger function described under "Environment difference on
  the current project" below, now surfaced by two definer-callable lints
  Supabase added after the 7-WARN baseline was written. Neither is 0028's.
- Migration 0033 (merchant activation: the `businesses` column fence, the three
  lifecycle RPCs, the queue index and two admin SELECT policies) added: no new
  advisors of any level. Verified live on 2026-08-01: still 0 ERROR and the same
  9 WARN. None of `submit_business_for_review`, `activate_business` or
  `reject_business_verification` appears in the definer-callable warnings,
  because EXECUTE on all three is granted to `service_role` only and all three
  pin `search_path = ''`; `private.has_usable_base_rule` is absent for the same
  reason plus a revoke from every role.

## Manual dashboard steps (pending)

- Enable leaked-password protection: Authentication -> Providers -> Email -> enable 'Leaked password protection' (advisor auth_leaked_password_protection; doc 15 requires it for production).

## Migration ledger (files vs live)

The committed files map 1:1 onto the live `supabase_migrations.schema_migrations`
ledger. Live versions are timestamps; the files use readable ordinal prefixes:

| file | live version | live name |
|---|---|---|
| 0000a_drop_legacy_licenses_payments.sql | 20260725161610 | 0000a_drop_legacy_licenses_payments |
| 0000b_drop_legacy_profiles_flags_feedback.sql | 20260725161619 | 0000b_drop_legacy_profiles_flags_feedback |
| 0001_foundations.sql | 20260725161645 | 0001_foundations |
| 0002_identity.sql | 20260725161811 | 0002_identity |
| 0003_auth_plumbing.sql | 20260725161844 | 0003_auth_plumbing |
| 0004_business_staff_self_select.sql | 20260725161855 | 0004_business_staff_self_select |
| 0005_businesses_staff_table_select.sql | 20260725161902 | 0005_businesses_staff_table_select |
| 0006_fix_businesses_staff_table_select.sql | 20260725161909 | 0006_fix_businesses_staff_table_select |
| 0007_catalog.sql | 20260725161952 | 0007_catalog |
| 0008_catalog_composite_fks.sql | 20260725162010 | 0008_catalog_composite_fks |
| 0009_fix_category_fk_set_null_column.sql | 20260725162020 | 0009_fix_category_fk_set_null_column |
| 0010_catalog_table_staff_policies.sql | 20260725162044 | 0010_catalog_table_staff_policies |
| 0011_identity_table_staff_policies.sql | 20260725162105 | 0011_identity_table_staff_policies |
| 0011b_business_food_types_table_staff.sql | 20260725162115 | 0011b_business_food_types_table_staff |
| 0012_campaigns.sql | 20260725162301 | 0012_campaigns |
| 0013_reward_claim_rpcs.sql | 20260725162402 | 0013_reward_claim_rpcs |
| 0014_realtime_reward_claims.sql | 20260725162415 | 0014_realtime_reward_claims |
| 0015_campaign_budget_lock.sql | 20260725162451 | 0015_campaign_budget_lock |
| 0016_claim_expiry_sweep.sql | 20260725162524 | 0016_claim_expiry_sweep |
| 0017_receipts.sql | 20260725162801 | 0017_receipts |
| 0018_award_receipt_points.sql | 20260725162910 | 0018_award_receipt_points |
| 0019_receipts_storage.sql | 20260725162949 | 0019_receipts_storage |
| 0020_realtime_receipts.sql | 20260725163012 | 0020_realtime_receipts |
| 0021_consumer_selfupdate_column_fence.sql | 20260725163042 | 0021_consumer_selfupdate_column_fence |
| 0022_audit_logs.sql | 20260725163156 | 0022_audit_logs |
| 0023_record_receipt_visit.sql | 20260725163327 | 0023_record_receipt_visit |
| 0024_template_embeddings.sql | 20260725171529 | 0024_template_embeddings |
| 0025_receipt_amount_ceiling.sql | 20260725182404 | 0025_receipt_amount_ceiling |
| 0026_notifications.sql | 20260725205211 | 0026_notifications |
| 0027_reference_data.sql | 20260725215529 | 0027_reference_data |
| 0028_scheduled_sweeps.sql | 20260725221121 | 0028_scheduled_sweeps |
| 0029_jobs.sql | 20260726033458 | 0029_jobs |
| 0030_notification_delivery.sql | 20260726033507 | 0030_notification_delivery |
| 0031_admin_access.sql | 20260726042144 | 0031_admin_access |
| 0032_integration_connections.sql | 20260726080854 | integration_connections |
| 0033_business_activation.sql | 20260731233249 | 0033_business_activation |
| 0034_business_merchant_aliases.sql | 20260801005736 | business_merchant_aliases |
| 0035_receipt_routing_visibility.sql | 20260801015558 | receipt_routing_visibility |
| 0036_receipt_escalation.sql | 20260801022854 | receipt_escalation |
| 0037_fixed_per_visit_dedup.sql | 20260806010927 | 0037_fixed_per_visit_dedup |
| 0038_fixed_per_visit_visit_day.sql | 20260806014838 | 0038_fixed_per_visit_visit_day |
| 0039_fixed_per_visit_excludes_clawback.sql | 20260806021026 | 0039_fixed_per_visit_excludes_clawback |
| 0040_campaign_budget_award_guard.sql | 20260806023604 | 0040_campaign_budget_award_guard |
| 0041_campaign_budget_attribution.sql | 20260806031837 | 0041_campaign_budget_attribution |
| 0042_points_expiry_stamping.sql | 20260806041646 | 0042_points_expiry_stamping |
| 0043_points_expiry_engine.sql | 20260806041706 | 0043_points_expiry_engine |
| 0044_points_expiry_warn.sql | 20260806041731 | 0044_points_expiry_warn |

**These versions are from the 2026-07-26 replay onto `zlfxfzlnklqhajacngxf`.**
Every migration was applied in file order in a single pass, so unlike the
first run there is no ordering inversion and no ledger-name drift: live names
match the file base names 1:1, with one exception noted in the table: 0032 was
applied through the MCP tool, which takes a snake_case migration NAME rather
than the file name, so it is recorded as `integration_connections`. The file
is still the source of truth and the ordering is unaffected. 0034 and 0035 were applied the same way and carry the same MCP snake_case names. See "Project history" below for why the replay
happened.

Notes:
- **0020 makes `receipts` a Realtime table.** Before it, the `supabase_realtime`
  publication contained only `reward_claims` (added by 0014), so
  `postgres_changes` subscriptions on `receipts` subscribed cleanly and then
  never fired. Both Realtime tables now carry `replica identity full`. WALRUS
  applies 0017's column-level grant to the payload, so a consumer still receives
  only the 13 granted columns of their own rows.
- `0000a`/`0000b` are historical one-time cleanups of an unrelated app that
  occupied the FIRST project this schema was built on. They are `if exists`
  no-ops on a fresh database and were no-ops on the 2026-07-26 replay. They are
  kept so the file set and the ledger stay 1:1.
- `0011b` is deliberately a no-op file: the policy conversion it applied live
  is contained in the amended `0011` for fresh replays. It exists only to keep
  the file set and the ledger aligned.
- **Before adopting the Supabase CLI** (`supabase db push` / `migration list`),
  rename these files to the timestamp form `<version>_<name>.sql` using the
  table above, so the CLI recognises them as already applied. Skipping that
  rename makes the CLI try to re-apply everything.

## Project history (why the ledger was rewritten on 2026-07-26)

The live project is **`zlfxfzlnklqhajacngxf`**, named **"Giya"**, in organization
`wztsksqtupnkwskxrhmq`, created 2026-07-24 14:50 UTC.

The retired one, `dcnpuvtbftpbcjcvfnlt`, is named **"latag-ph"** and belongs to a
DIFFERENT Supabase account, in the Vercel-linked organization
`vercel_icfg_0cIUClNbOJ7jyuSdWy9qoyTq`, alongside LPG-IMS and BUCS PolicyPulse.
It is a separate live application of the same owner, not a spare project. That is
why it already held tables when this schema was first applied, and it is why
migrations 0000a and 0000b dropped `licenses`, `payments`, `pricing`, `profiles`,
`feature_flags` and `feedback` from an app that was actually using them. Treat
"this project already has tables in it" as a signal to identify the project
before dropping anything, not as evidence that the tables are stale.

**The trap that caused it, and how to avoid repeating it.** A persisted
User-level `SUPABASE_ACCESS_TOKEN` environment variable on the workstation points
at the latag-ph account, and it OVERRIDES `supabase login`. Logging out and back
in does not change which account the CLI acts as; `supabase projects list` keeps
showing the other account's projects. Either remove that variable, or pass the
right token explicitly per command. The two accounts share no projects, so
`projects list` is the reliable check: the Giya account sees exactly one project.

Everything through 2026-07-25 was applied to a different project,
`dcnpuvtbftpbcjcvfnlt`, because that ref was hard-coded in the Supabase MCP
server config (`~/.claude.json`, `mcpServers.supabase.args`,
`--project-ref=`). A pinned-ref MCP server exposes exactly one project and
offers no way to create one or choose an organization, so every migration went
to the only database the tooling could see. The mix-up was not caught earlier
because a ref pasted in chat and the ref in the config were treated as the same
thing.

The correction was cheap precisely because these files are the source of truth:
the full set replayed onto the correct project in one pass with no edits, all
nine pgTAP suites passed (275 assertions), and the regenerated TypeScript types
came back **byte-identical** to the committed ones, which is the strongest
available evidence that both databases ended up with the same schema.

Two consequences worth knowing:

- **Live versions in the ledger above changed.** They are the replay
  timestamps, not the original ones. Any older note quoting a `202607241…` or
  early `202607251…` version refers to the retired project.
- **`dcnpuvtbftpbcjcvfnlt` still exists** and holds this schema plus a handful
  of E2E test rows. It has no production value and should be decommissioned so
  there is no ambiguity about which project is live.

### Environment difference on the current project

`zlfxfzlnklqhajacngxf` carries a pre-existing event trigger, `ensure_rls` on
`ddl_command_end`, calling `public.rls_auto_enable()`. It re-runs
`alter table ... enable row level security` on newly created `public` tables and
swallows every exception. It is harmless here because every migration enables
RLS explicitly, and it never touches the `private` schema.

It does however carry the default `EXECUTE` grant to `PUBLIC`, so PostgREST
exposes it at `/rest/v1/rpc/rls_auto_enable` as a `SECURITY DEFINER` function
callable by `anon`. That is the only security advisor on this project beyond the
accepted baseline. An event trigger fires regardless of `EXECUTE` grants, so the
fix costs nothing:

```sql
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
```

Left in place pending a decision, since the function predates this schema and is
not created by any migration here.
