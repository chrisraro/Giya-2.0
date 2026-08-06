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

Twenty-five suites, one per domain (review fix, task 2.1: the prior count of "Nineteen" - itself already a correction attempt - was still wrong; four existing suites had never been added as table rows at all: `receipt_escalation_smoke.sql`, `rls_jobs_smoke.sql`, `rls_merchant_aliases_smoke.sql`, `rpc_campaign_budget_guard_smoke.sql`, restored below in their migration order rather than appended, so this table reads in the same order the suites were written; task 2.5 adds two more, `rls_job_alert_state_smoke.sql` and `rpc_job_health_terminal_failures_smoke.sql`):

| file | covers |
|---|---|
| `rls_identity_smoke.sql` | identity tables and their policies (0001-0006, 0011) |
| `rls_catalog_smoke.sql` | catalog tenancy and composite FKs (0007-0010) |
| `rls_campaigns_smoke.sql` | campaigns, points rules, ledger immutability (0012) |
| `rpc_claim_smoke.sql` | `claim_reward`, `validate_redemption`, `expire_claims` (0013, 0016); task 1.4's `cancel_claim` (0050-0051, 76 assertions after the review-fix pass) - happy-path cancel restoring balance/inventory in one reversal row, wrong-owner FORBIDDEN, already-redeemed and already-cancelled refusals (idempotent, no double reversal), the redeem-vs-cancel race in both directions via sequential state simulation (`validate_redemption`'s own new `CLAIM_ALREADY_CANCELLED` branch), and the full grant matrix including the shared `private.reverse_claim_ledger` helper and `cancel_claim`'s `service_role` denial (0051 review fix M6). `expire_claims` skipping a cancelled claim is proved against a claim BACK-DATED INTO THE PAST AFTER being cancelled (0051 review fix I1) - without that, `expires_at <= now()` alone would already exclude it from the candidate scan and the assertion would prove nothing about the `status = 'claimed'` filter actually doing the excluding; the proof asserts the sweep's return value, the claim's status, AND the balance (the one that actually catches a double-reverse) |
| `rls_receipts_smoke.sql` | receipts evidence fences, column grant, the three unique amendments, the delete and immutability triggers (0017) |
| `rpc_award_smoke.sql` | `award_receipt_points`: guard order, one earn per receipt, the `balance_after` chain, the Manila-day visit rule (0018); the `fixed_per_visit` VISIT-DAY dedupe and its `FIXED_PER_VISIT_RACE` backstop, keyed on `manila_day(coalesce(receipt_date, created_at))` rather than processing time, including the review-lag/backdated-upload cases and the two I3 cases where a prior earn that was not itself a PAID fixed_per_visit base must not suppress a later one (0037, 0038) |
| `rls_consumer_fence_smoke.sql` | the `consumers` / `profiles` self-update column fence: legitimate profile and onboarding writes still land, fraud and trust columns raise 42501 (0021) |
| `rls_audit_logs_smoke.sql` | `audit_logs`: the owner-only tenant read and the manager narrowing, platform-level rows (null `business_id`) invisible to every tenant, the `ip` / `user_agent` column fence, client writes refused at the privilege layer, the append-only row trigger and the no-truncate statement trigger, the service_role split (INSERT stays, everything else revoked), and the `action` / `entity_type` shape constraints plus the mandatory admin reason (0022) |
| `rpc_record_visit_smoke.sql` | `record_receipt_visit`: guard order, the doc 40 Asia/Manila visit rule including the UTC/Manila date-boundary case and backdated receipts, spend accumulation, the points columns left untouched, idempotency of a second call, the service_role-only grant, and the interaction with the award path (an award after a recorded visit mints points without adding the same receipt's spend twice) (0023) |
| `rls_template_embedding_smoke.sql` | pgvector template embeddings: the pinned vector(384) width enforced rather than decorative, cosine ordering, and that RLS still applies to a vector query (0024) |
| `rls_notifications_smoke.sql` | `notifications`: recipient-only reads, the read_at column grant, and the narrow trigger that permits marking read while refusing a body edit (0026) |
| `ref_data_smoke.sql` | reference data: both tables non-empty, the seed idempotent on replay, every city carrying a non-null province and region in one of the 18 real regions (0027) |
| `rls_jobs_smoke.sql` | `jobs` (0029), 25 assertions: the service-role-only fence (no policies at all, privileges revoked underneath so a client denial is loud rather than an empty result), the service_role privilege split, the no-truncate statement trigger, the partial dedupe index proven BOTH directions (blocks an in-flight duplicate; does not block a re-enqueue after the first one died), the `queue` shape check, the status vocabulary, the two lifecycle constraints, and doc 39's claim protocol |
| `rls_admin_smoke.sql` | the admin surface (0031): every admin SELECT policy 0017 and 0022 deferred, asserted as a PAIR (an admin session reads another tenant's fraud signals, receipts, line items, OCR evidence, AI spend, audit rows and platform settings; a non-admin owner of a real tenant reads none of them and still reads their own), the unmatched receipt (`business_id` null) that 0017 noted no audience could see, the column fences that an admin policy deliberately does NOT widen (`receipts.parse_meta`, `audit_logs.ip`), and `clawback_receipt_points`: the service_role-only grant, the mandatory reason, table-truth actor verification (a `support` admin is refused), `CLAWBACK_INVALID_STATE` for a receipt with no earn row and for a second attempt, the negative ledger row with `reverses_id` and its `balance_after` under the pair lock, the receipt landing on `rejected`/`fraud_suspected` with `reviewed_by`, the in-transaction audit row, and doc 35's clamping with the residual recorded as `after.shortfall_points` |
| `rpc_sweeps_smoke.sql` | the two scheduled sweeps: `sweep_stuck_receipts` moves a stuck, out-of-budget receipt to `review` with `reject_reason` null, the note `ocr_operator_failure:sweep` and `parse_meta.review_reasons = ["ocr_operator_failure"]` (**changed by 0035, decision D7** - every receipt this sweep can see is one WE failed to process, because an unreadable IMAGE is finalized on the attempt that discovered it, so the old `rejected` / `manual` / `processing_failed` told a paying customer their photograph was the defect when the likeliest cause was an exhausted Vision quota), while a receipt with a NULL `business_id` is still dead-lettered because 0017 gives no RLS audience a path to it, and both a receipt still inside its attempt budget and a receipt that is merely recent are left completely untouched, the business-scope `ocr.max_attempts` override widens the budget and withdrawing it narrows it again, a second run is a no-op, no ledger row is written, both `cron.job` rows carry the expected schedule and command, `expire_claims` still runs clean, and every function is service_role only (0028, 0035) |
| `rpc_activation_smoke.sql` | merchant activation (0033), 52 assertions: THE COLUMN FENCE ON `businesses` asserted both ways (an owner's session with a real `biz` claim gets 42501 writing `status`, `verified_at` or `plan`, and the same session still edits `name` and the edit lands, so the refusals are about COLUMNS and not about a policy that missed), `private.has_usable_base_rule` including the half-filled `amount_rate` row with a null rate that passes every table constraint and awards nothing, the service_role-only grant on all three RPCs, `submit_business_for_review` (owner-only by table truth, refused for a tenant with no usable rule, opens a `business_verifications` round, writes an `actor_kind='user'` audit row, and refuses a second submission), `activate_business` (mandatory reason, `support` refused, the tenant's own owner refused, ACTIVATION_NO_EARNING_RULE when the rule is deleted between submission and decision with nothing written by the refusal, then success stamping `verified_at`, closing the round as approved with `decided_by`, and writing an `actor_kind='admin'` audit row carrying the reason), `reject_business_verification` (back to draft, round closed as rejected, and the merchant reading `decision_reason` UNDER THEIR OWN SESSION), and 0033's two admin SELECT policies as a pair |
| `rls_integration_connections_smoke.sql` | `integration_connections` (0032): THE TOKEN COLUMN FENCE, asserted as the pair that matters (an owner reading their OWN tenant row gets 42501 on `access_token_encrypted` and `refresh_token_encrypted`, and on `select *`, while every allowlisted column reads cleanly), the owner/manager role list and the marketing narrowing, cross-tenant denial, the consumer and anon matrix rows, no client write path of any kind, the service_role split (insert/update/delete stay, TRUNCATE goes), the no-truncate statement trigger, and the four check constraints: the plaintext envelope fence (a raw `EAAG...` token is refused because its first byte is not the envelope version), the error/status pairing in both directions, and the provider and status vocabularies, plus the account uniqueness rule that reconnect upserts onto |
| `rls_merchant_aliases_smoke.sql` | `business_merchant_aliases` (0034), 30 assertions: the generated normalization column, which MUST agree character-for-character with `normalizeForMatch` (`src/features/receipts/matching.ts`) or an alias a merchant taught is never found by the matcher that reads it; the unique index that makes the review queue's one-tap idempotent and race-free; the owner/manager narrowing and cross-tenant deny; the FK cascade and set-null semantics; the three-layer privilege fence including the service-role-only write posture; and the structural fact the whole feature rests on - an alias can exist for a business with NO `receipt_templates` row at all, which is why aliases live in their own table rather than `receipt_templates.parse_config` |
| `rpc_routing_breakdown_smoke.sql` | `receipt_routing_breakdown` (0035, decision D10), 14 assertions over two tenants: the four outcome buckets with queued/processing collapsing to `pending`, attribution counted once per receipt including a receipt that tripped two rules (so the reason counts exceed the review count, which is correct rather than a rounding error), D7's `ocr_operator_failure` attributed like any other reason, BACKFILL HONESTY (a review whose `parse_meta` predates `review_reasons` counts as `unattributed` and never inflates a real rule), TENANCY asserted as the pair that matters (one tenant's breakdown never carries the other's reason, and the platform-scoped `p_business_id null` call does see both), the `p_days` window filter and its clamp, and the service_role-only grant that keeps an aggregate from routing around 0017's `parse_meta` column fence |
| `receipt_escalation_smoke.sql` | `receipts.escalated_at` (0036), 12 assertions, deliberately scoped to what only the DATABASE can answer (the guards deciding whether an escalation may happen at all - submitter check, cap, excluded fraud family, once-per-receipt - are code, owned by `escalate.test.ts`): THE COLLISION IS REAL - `receipts_number_unique` (0017) covers `('approved','review','processing')` and excludes `'rejected'`, so moving a rejected receipt back into `'review'` collides with any live row already claiming its number, and this is the single most important assertion in the file, proof the pre-check and the 23505 catch in `escalate.ts` are load-bearing rather than defensive decoration; the write fence is unchanged (a consumer still cannot UPDATE `receipts`); the read grant reaches the consumer (the column grant + `receipts_consumer_select`, since the escalation is once per receipt forever and the consumer's own screen must be able to see it happened); and 0035's routing breakdown attributes an escalation to its own reason rather than crediting whatever rejected the receipt first |
| `rpc_campaign_budget_guard_smoke.sql` | the campaign budget race guard in `award_receipt_points` (0040/0041, task 1.2 + review fix C1), 34 assertions: CORRECT PER-CAMPAIGN ATTRIBUTION from each earn row's own `rule_snapshot` entries - never a naive `sum(points) where campaign_id = X`, which is wrong in both directions the moment a campaign stacks as a non-primary contributor (review C1); `max_total_points` as a running cap shared across every consumer, closed race-safely by locking the campaigns row before re-checking the total (the same cross-consumer race 0015 hardened for `claim_reward`); `per_customer_limit` armed at award time on its own, not only when `max_total_points` is also set (review I1); a budget with room for exactly one more contribution and two sequential awards - the second raises `CAMPAIGN_BUDGET_RACE`, and a corrected retry (the value `award.ts`'s own recovery sends) succeeds; a clawed-back contribution stops counting against the budget; a vanished/unknown campaign id in the array is skipped, not fatal; and omitting `p_campaign_budget_checks` entirely (every caller before task 1.2) enforces nothing, byte-identical to 0038's prior behaviour |
| `rpc_points_expiry_smoke.sql` | Task 1.3 points expiry enforcement (0042-0048, both review-fix passes), 67 assertions: doc 35 section 7's FIFO remainder formula ordered by EXPIRY not creation (I1) - a partially-consumed lot, a later untouched lot, a lot fully drained to 0, a clawback-only consumption, and the counter-example where a never-expiring `adjust` must be drained LAST rather than first (a null expiry sorting as `+∞`, not first); the aggregate at two `asof` values and the public wrapper agreeing with it; `public.points_next_expiry` correctly excluding an already-past-due lot; `public.expire_points` (the sweep) - SELF-CLEARING proven with a small `p_limit` (I2: a third pair is reached only once the first two clear a slot, not starved forever), the right `expire` row with the restored `x_expired_sum`/`d_drained_sum` audit fields (I5), the cached balance equal to the ledger sum, nothing for a zero-balance pair, a backfilled-already-past-due lot swept correctly (M5), and idempotency across every pair including the self-clearing trio; `public.points_expiry_warn` (the warn job) using the PROJECTED remainder at both horizons rather than the soonest lot (original I3: a shadowed larger lot fires its own combined total on the first run), ordered by URGENCY - soonest in-window expiry, not UUID - so a p_limit of 1 notifies a 2-days-out pair over a UUID-earlier 25-days-out one (re-review N2), deduped on the WINDOW-STABLE soonest-lot date rather than the moving projected figure, proven by literally aging the ledger between runs to simulate a day passing: a growing aggregate (300->500) produces no duplicate, only a genuine change of the soonest lot does (re-review N3), the restored date in both the copy ("expire by...") and the `data.expires_on` payload (re-review N4), the in_app/email channel split, a backfilled-already-past-due lot never warned (M5), and idempotency; both `cron.job` rows with their exact schedule and command; the append-only fence's one permanent exception (now correctly homed in 0047, not rewriting 0042's history) proven both ways (I4: the null-to-value transition succeeds and lands, every other column and every other `expires_at` transition and DELETE still raise), with its column allowlist pinned exactly (re-review N7); and the full I-A grant matrix including `public.points_expirable_remainder`, missed by the first pass (C1) |
| `rpc_campaigns_sweep_smoke.sql` | Task 2.1 `campaigns.sweep` (0053, review-fixed twice by 0054 and 0055), 33 assertions: doc 34's T3 (`scheduled -> active` at `starts_at`) and T7 (`active|paused -> ended` at `ends_at`) as ONE `public.sweep_campaigns` function with two independent candidate scans; a due scheduled campaign on an ACTIVE business activates with a `campaign.activated` audit row (`actor_kind='system'`, `after.trigger='sweep'` - the app's own vocabulary from `src/features/campaigns/server/audit.ts`, never a parallel verb); a not-yet-due scheduled campaign and both an already-`ended` and an already-`archived` campaign are left completely untouched with no audit row; an `active` campaign AND a `paused` campaign both past `ends_at` are ended with `campaign.ended` recording the correct source status in `before`, PROVEN AGAIN on a business the T3 skip case has already made suspended (T7 is unconditional and a fixture now pins that rather than leaving it asserted only by construction); G1 (business standing) gates T3 alone - a due scheduled campaign on a SUSPENDED business is SKIPPED (stays `scheduled`, no audit row, no error) and then genuinely activates once the business is set back to `active`, proving the skip re-checks live standing rather than caching a verdict; GENUINE SELF-CLEARING under a TIGHT `p_limit=1` (0054 review fix I1/I2, the actual 0045-shaped bug 0053 shipped with: a `p_limit=200`/8-fixture "second run is 0" check cannot distinguish "left candidacy" from "still occupying a slot doing no work" the way a small-limit starvation probe can - a permanently-ineligible `'closed'`-business campaign sorted first by `starts_at` no longer starves a later, gate-passing one out of the budget); `private.campaigns_sweep_ineligible_count()` (0055 review fix I1: 0054's own I1+I3 interaction silently dropped skip visibility to zero for the ordinary case) returning exactly the one due-but-ineligible campaign in play, fully revoked from every role including `service_role`; the widened `campaigns_active_window_idx` (now covering `paused`, which 0012's original predicate excluded); the `cron.job` row's exact schedule (`*/5 * * * *`) and command; no `points_transactions` row written by any of it; and the service_role-only grant |
| `rls_job_alert_state_smoke.sql` | `job_alert_state` (task 2.5, filed as 0059 / applied live as 0058_job_health_alerts - see that file's own ledger-name note), 13 assertions: the service-role-only fence (no policies at all, privileges revoked underneath), the service_role privilege split - the opposite shape from `jobs` (0029): DELETE stays and TRUNCATE does not, because the checker's own recovery path IS a per-row delete rather than never deleting at all - the no-truncate statement trigger, and the one shape check (a blank `jobname` is rejected) |
| `rpc_job_health_terminal_failures_smoke.sql` | `public.sweep_job_terminal_failures` (0061, task 2.5 review-fix pass 2), 12 assertions: THE REGRESSION TEST for the bug the migration exists to close - a job whose only run in the window is in-flight (`status='running'`) reports zero terminal failures and zero terminal runs, unlike 0028's own `sweep_job_health.failures` (`status <> 'succeeded'`), which would count it as one; a mixed fixture (one succeeded run, two genuinely failed runs 30 minutes apart, one in-flight) proving `terminal_runs` excludes the in-flight row, `terminal_failures` counts only `status='failed'`, and the MOST RECENT failure's message wins over the older one; the `p_hours` window genuinely bounding the read (a 1-hour window sees the 30-minutes-ago failure but not the ones 2h/3h back); and the full I-A grant matrix (anon/authenticated denied both by `throws_ok` on a direct call and by literal `has_function_privilege` assertions, service_role allowed). Fixtures go through `cron.schedule()` for the job row (direct `INSERT` on `cron.job` is refused even to `postgres` - verified live, the table is owned by `supabase_admin`) and a direct `INSERT` with an explicit out-of-range `runid` for `cron.job_run_details` (directly insertable, but its `runid` sequence is not) |

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
| `campaigns.sweep` | `*/5 * * * *` | `public.sweep_campaigns(200)` | Doc 34 section 3's own cadence for this queue ("every 5 minutes"), driving both the T3 (`scheduled -> active` at `starts_at`) and T7 (`active|paused -> ended` at `ends_at`) transitions. Tighter than the daily points-expiry cadence because a campaign's schedule is merchant-authored down to the minute (a "starts at 9am" promo), unlike a flat 12-month expiry clock; looser than a per-campaign timer because doc 34's own latency contract is "state visible within one sweep interval (~6 minutes)" and consumer-facing liveness additionally checks `isCampaignLive`'s window, so sweep lag can never show an expired promo as claimable in the meantime. |

All five jobs run as `postgres`, which owns every function and so retains
EXECUTE independently of the `service_role`-only grants. All five functions
are idempotent (`points.expiry_sweep`/`points.expiry_warn` by recomputing the
same FIFO formula from the ledger each run - see `rpc_points_expiry_smoke.sql`
- the other three via `for update skip locked`), so an overlapping run or a
concurrent application write is safe.

### Points expiry (0042-0048, task 1.3 + two review-fix passes)

The 12-month rolling expiry published in the consumer terms and on the
wallet is enforced by three pieces, all sharing ONE FIFO formula
(`private.points_lot_remainders`, doc 35 section 7):

- **Stamping** (0042): `award_receipt_points` now stamps every positive earn
  row `expires_at = now() + interval '12 months'` itself (a caller-supplied
  `p_expires_at` still overrides it, but no caller sends one today) - the
  single earn-writer chokepoint, so no future writer can forget it. 0042
  backfills the earn row(s) that predate it exactly as it originally ran on
  2026-08-06: `points_transactions_append_only` is disabled for that one
  `UPDATE` statement and re-enabled immediately after, in the same
  migration. **This file is restored to that real history** - a first
  review-fix pass had rewritten it in place to install a permanent narrow
  guard instead, which was the right END STATE reached the wrong way (see
  0047's own header and the Notes entry below for why: `supabase db push`
  compares recorded version/name, not file content, so a database that had
  already run old-0042 would never receive a silently-rewritten body).
- **The append-only fence's permanent narrow guard** (0047, review fix I4,
  correctly homed): `private.points_transactions_append_only` permits
  exactly one transition, `expires_at` moving from null to a value with
  nothing else on the row changing, forever - not a disable/re-enable pair a
  future author could point to as precedent for taking the fence down for
  their own, different write. Mirrors 0026/0030's `notifications_read_at_
  only` exactly. This migration is a live no-op on `zlfxfzlnklqhajacngxf`
  (the guard reached this project out-of-band during the first review-fix
  pass, before this correction) - see 0047's header and the `0011b` note
  below for why that is fine and expected. Its column allowlist is pinned
  exactly in `rpc_points_expiry_smoke.sql` (review fix N7), so a column added
  to `points_transactions` later without a decision about this guard fails
  the suite instead of silently becoming mutable.
- **The FIFO formula orders by EXPIRY, not creation** (0045, review fix I1):
  a lot with no expiry (a future `adjust`/`referral_bonus`, doc 35 section 8)
  sorts as `+∞` and is drained LAST, never first - getting this backwards
  would expire points a redemption had already, honestly, spent.
- **The sweep** (`public.expire_points`, 0043/0045): writes one `expire`
  ledger row per (business, consumer) pair whose past-due lots still have a
  positive FIFO remainder, floored at 0, never driving the balance negative.
  Its candidate scan is SELF-CLEARING (0045, review fix I2): the exact
  condition (`private.points_expirable_remainder(...) > 0`), not merely "a
  past-due row exists", so a fully-drained pair drops out of candidacy and a
  small `p_limit` cannot starve pairs beyond it forever. Its `expire` row
  carries `x_expired_sum`/`d_drained_sum` alongside `remainder` (0045, review
  fix I5) - doc 35 section 7's own snapshot shape, restored: since no
  consumption links are stored anywhere, those two sums are the only record
  of what a given sweep saw.
- **The warn job** (`public.points_expiry_warn`, 0044/0046/0048): raises
  `kind='points_expiring'` using the PROJECTED remainder at the 30-day and
  7-day horizons (original review fix I3) - the same formula the sweep uses,
  at `now()+30d`/`now()+7d` - not "the soonest lot's own date", which could
  shadow a larger, later lot and leave it with no real lead time at all. Its
  candidate scan orders by URGENCY - soonest in-window expiry ascending, not
  UUID order (0048, re-review N2) - because a persistent backlog under a
  fixed sort would starve every pair beyond `p_limit` PERMANENTLY (unlike the
  sweep, a warn candidate does not clear itself just by being warned about),
  so the one slot under a small limit now goes to whoever is closest to
  losing points. Deduped on the WINDOW-STABLE soonest-lot date (0048,
  re-review N3), never the projected figure itself: the figure grows every
  night as more lots enter the 30-day window and shrinks whenever a
  redemption or the sweep changes an earlier remainder, so keying on it
  produced a fresh notice - in the unrecallable channel - every single
  night for any multi-lot consumer. The soonest lot's date is stable across
  that churn (new lots entering are always later, never earlier) and changes
  only when it is a genuinely new fact worth telling someone. That same date
  is restored to both the copy ("N pts at Shop expire by <date>") and
  `data.expires_on` (0048, re-review N4 - doc 35's own `{points, expires_on}`
  vocabulary). Still locked `for update skip locked` (0046, review fix M1) so
  two overlapping runs cannot both pass the dedupe check for the same pair.
  It writes directly into `public.notifications` rather than calling
  `src/features/notifications/server/raise.ts`, because pg_cron cannot reach
  TypeScript - the `in_app` row is a complete delivery, the `email` row is
  durable but unsent (nothing enqueues a `notify.email` job for it yet; see
  0044's header for the honest accounting of that gap, and `src/features/
  notifications/kinds.ts`'s registry comment on the same point).

The wallet's own "what expires when" line (`public.points_next_expiry`) reads
the identical formula, so the number a consumer sees is the number the sweep
will eventually take.

### Campaign sweep (0053-0055, task 2.1 + two review-fix passes)

`public.sweep_campaigns` closes doc 34's two time-driven lifecycle
transitions that had nothing firing them (`service.ts`'s
`emitLifecycleEvent` carried `// TODO(api): wire ... the ends_at sweep
worker` since task 1.7): T3 `scheduled -> active` at `starts_at`, and T7
`active|paused -> ended` at `ends_at`. One function, two independent
candidate scans, each bounded by its own `p_limit`:

- **T3** re-checks G1 (business standing) alone, not the full G1-G3 doc 34
  names for this trigger - see 0053's header for why G2/G3 are scoped out
  (they were already true at schedule time and are not the sweep's to
  silently fix if they regressed). A due campaign whose business is not
  currently `status = 'active'` is SKIPPED - left `scheduled`, never
  activated and never errored.
- **T7** is unconditional: an ended window ends regardless of business
  standing. Both `active` and `paused` sources share one scan; the
  transitioning UPDATE's own `status = <source>` predicate is what keeps
  each row self-clearing regardless of which of the two it started from.
  Pinned by a dedicated pgTAP fixture (review fix minor) on the SAME
  suspended business the T3 skip case uses, so a future accidental G1 check
  on T7 would fail a test rather than ship silently.

Both transitions write an `audit_logs` row reusing the app's OWN verb
registry (`src/features/campaigns/server/audit.ts`'s
`CAMPAIGN_LIFECYCLE_ACTIONS` - `campaign.activated` / `campaign.ended`) with
`actor_kind='system'`, `actor_id` null, and `after.trigger='sweep'` - the
same discriminator task 1.7's `service.ts` writes `'manual'` for every
staff-initiated transition, not a parallel verb like
`campaign.activated_by_sweep` that would fragment the vocabulary 0022/task
1.7 unified. A skipped campaign gets no audit row: nothing happened to it.

**Review fix I1 (0054) - T3's skip WAS the 0045 shape.** 0053 shipped with
the business-standing check living INSIDE the T3 loop body: the WHERE
predicate was just `status='scheduled' and starts_at<=now()`, which stays
true forever for a row whose business will never return to `'active'`
(`businesses.status` includes the terminal value `'closed'`). Worse than
0045's own bug: T3 orders by `starts_at`, so a permanently-skipped row's key
never moves and it sorts EARLIER than every campaign scheduled after it on
every future run - enough dead rows fill `p_limit` and every later,
gate-passing campaign silently never activates. 0053's own claim that this
was "not the 0045 bug" (both in its migration header and its task report)
was wrong; fixed by moving the condition into the WHERE clause as an
`exists(select 1 from businesses where id=business_id and status='active')`
predicate, exactly 0045's own precedent, so an unresolvable row never
occupies a `p_limit` slot in the first place. The in-loop recheck stays as a
race backstop (the `exists()` snapshot and the row's lock are not atomic)
but is no longer the sweep's primary skip mechanism.

**Review fix I2 - the original self-clearing assertion proved the wrong
thing.** A `p_limit=200` check against 8 fixtures cannot tell "the
transitioned rows left candidacy" from "a skipped row is still occupying a
slot doing no work", because a re-selected-but-skipped row's UPDATE also
carries `and status=<source>` and matches 0 rows either way. Fixed the same
way `rpc_points_expiry_smoke.sql` proves 0045's own fix: a `p_limit=1` case
with a permanently-ineligible campaign engineered to sort FIRST - it starved
the gate-passing campaign behind it before the I1 fix, and no longer does
after.

**Review fix I3 (0054) - `raise notice` reached nobody.** NOTICE sits below
Postgres's default `log_min_messages = warning`, so the skip message was
never written to the server log, and pg_cron's `cron.job_run_details`
records only the run's completion status and (on failure) its error
string - never a NOTICE from a successful run. Changed to `raise warning`.

**Review fix I1 (0055) - I1 and I3 (both 0054) interacted, and 0054 shipped
without noticing.** Moving the business-standing check into the WHERE
clause (I1) and raising the skip message's severity (I3) happened in the
SAME migration, and together they cancelled each other's purpose: once T3's
scan itself excludes an ineligible row, the loop body - and its
`raise warning` - never runs for it at all. For the ORDINARY case (a due
campaign on a suspended/closed business) skip visibility went from "a
NOTICE nobody can read" to nothing whatsoever; the per-row warning now fires
only inside the sub-millisecond race window between the `exists()` snapshot
and the row's lock. 0054's own header and an earlier version of this section
both claimed skips were "readable via `mcp__supabase__get_logs` / the
dashboard's Postgres logs" - never true for the ordinary case even at 0054,
and corrected here. **Fixed** with ONE `raise warning` per run carrying a
COUNT of due-but-ineligible scheduled campaigns, from
`private.campaigns_sweep_ineligible_count()` - a small, directly-testable
`stable` SQL helper (revoked from every role including `service_role`,
0045's own precedent), computed independently of `p_limit` and the
transition budget so the number is honest regardless of backlog size or how
tightly `p_limit` is set. The in-loop per-row warning from 0054 is kept for
the race window it genuinely covers.

Noted, not fixed (architectural, predates this sweep) - and less permanent
than first described: a `scheduled` campaign whose `ends_at` has ALSO
already passed, on a business that is not currently `'active'`, cannot be
resolved today (T7 only ever scans `status in ('active','paused')`, and doc
34's edge set has no `scheduled -> ended` transition at all), so it sits
`scheduled` with a stale `ends_at`. But it is SELF-RESOLVING the moment the
business returns to `'active'`: the next `sweep_campaigns()` call activates
it in the T3 loop, and because that same call's T7 loop runs immediately
afterward against the freshly-committed state, it finds the row already
`active` with `ends_at <= now()` and ends it in the SAME call - one
invocation, a legal `scheduled -> active -> ended` path, both audit rows.
The dead end is exactly co-extensive with "the business never comes back",
not a state nothing can ever resolve.

0012's `campaigns_active_window_idx` predated this sweep and only covered
`status in ('scheduled','active')`; widened here (drop + create, since a
partial index predicate cannot be altered in place) to include `paused`, so
the T7 scan's paused half is index-assisted too.

Covered by `rpc_campaigns_sweep_smoke.sql`, 33 assertions (24 original + 7
added by the first review-fix pass: 2 pinning T7 unconditionality on a
suspended business, 5 proving the I1/I2 starvation-then-fixed behaviour
under `p_limit=1`; 2 more added by the second pass, proving
`private.campaigns_sweep_ineligible_count()`'s value and its full grant
denial).

**Process note (M2):** 857ab86, during the first review-fix pass, edited
0053's header COMMENT (outside the `$$` function body) in place to fix a
misattribution, on the reasoning that `pg_proc.prosrc` was genuinely
unaffected. Flagged in review as still wrong to do: this repo treats "never
edit an applied migration in place" as absolute, precisely because "it's
only a comment" is how the 0047 incident below began. No revert was needed
(0053's header reads correctly after that edit), but every correction to
0053 or 0054 from here on goes in a companion migration - 0055 is that
migration for 0054's own I1/I3 interaction.

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

- **Points-expiry warnings burst for a dense-lot consumer (I-D).** The warn
  job notifies per *lot*: the dedupe key is `(pair, horizon, soonest lot's
  expires_at)`, so a new notice fires each time a different lot becomes the
  soonest. That is correct and deliberate - it is what stopped 0046's nightly
  duplicate - but it means the archetypal daily-coffee customer, who earned on
  ~30 consecutive days twelve months ago, enters a tail phase where one lot
  expires each night and promotes the next. Each newly-promoted lot is already
  inside 7 days, so BOTH horizons fire together: roughly two notices a day for
  about thirty days, in the channel `src/features/notifications/kinds.ts`
  itself calls the one that "cannot be recalled".
  The fix is to coalesce rather than to re-key: one notice per pair per horizon
  per *window* (bucket on the horizon edge's Manila day rather than on lot
  identity), with copy naming a range - "1,250 pts expire between Mar 3 and
  Apr 2". At most one 30d and one 7d message per pair per rolling period
  regardless of lot density, which matches how a consumer experiences this: as
  one situation, not thirty. Not yet built; no consumer has hit it because no
  lot is near expiry yet.
- **Backfilled expiry lots get no grace period (I-B, decision recorded).**
  `0042`'s backfill stamps `expires_at = created_at + 12 months` on earn rows
  that predate the column, so a row older than twelve months is past due the
  moment it is stamped and is swept without ever being warned (the warn job
  only sees `expires_at > now()`). This is deliberate: the 12-month policy has
  been published in the consumer terms since before those points were earned,
  so honouring it is not retroactive. Pinned by the pgTAP fixtures asserting a
  backfilled past-due lot is swept and never warned. Recorded here rather than
  in 0042, which must not describe anything that came after it.
- **`cancel_claim` (0050/0051, task 1.4, M8, decision recorded) removes a cap
  that used to be implicit.** `reward_claims.per_customer_limit` and
  campaign `budget.max_redemptions` (0013) both count non-cancelled claims
  only - correct and pre-existing, but before this task nothing ever wrote
  `status='cancelled'`, so the exclusion had no real consequence. Now a
  consumer can claim -> cancel -> claim the same reward without bound. No
  attacker gain (nothing is minted; each cycle is a genuine debit and a
  genuine, immediate refund) and no cross-tenant impact, but it writes two
  extra append-only ledger rows per cycle onto the consumer's own statement.
  Deliberately not bounded in task 1.4 - see
  `docs/30-modules/35-points-engine.md` section 6's "Consumer cancel"
  paragraph for the full reasoning. Owed: a decision on whether/how to
  rate-limit repeated claim/cancel cycles, if it proves to matter in
  practice.

- **`campaigns.sweep` (0053, task 2.1) transitions carry no cache/embed/send
  side effects.** `public.sweep_campaigns` writes `campaigns.status` and its
  own `audit_logs` row directly - it is plpgsql, so it cannot call
  `src/features/campaigns/server/service.ts`'s `emitLifecycleEvent` seam the
  way every staff-initiated transition does, and therefore cannot fire doc
  34 section 2's "side effects" table entries for T3 (`->active`: cache
  invalidation, `ai.embed_refresh`, marketing-send materialization) or T7
  (`->ended`: cache invalidation, embed downrank). A sweep-driven activation
  is correct in the database and in the audit trail from the first instant,
  but a portal page cached under the old status, or the assistant's RAG
  index, will not reflect it until whatever normally refreshes those runs
  again for an unrelated reason. Same species of gap as
  `points.expiry_warn`'s unsent email row below: the database sweep can only
  ever do the honest SQL-reachable half. Owed: either a TypeScript-side
  poller that reads what the sweep just changed, or moving the side-effect
  triggers to fire off the `audit_logs` row itself (`action` LIKE
  `'campaign.%'`) rather than off the `emitLifecycleEvent` call site, so a
  swept transition and a manual one are indistinguishable to every reader
  downstream of the audit trail.

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
- Migration 0050 (task 1.4: `cancel_claim`, the re-created `expire_claims` and
  `validate_redemption`, and the shared `private.reverse_claim_ledger`
  helper) added exactly one new advisor: `public.cancel_claim` is
  authenticated-callable `SECURITY DEFINER`. Accepted, same category as
  `claim_reward` and `register_business` above - it is the designed
  consumer-facing entry point (doc 03 Key Finding 1). Verified live on
  2026-08-06: still 0 ERROR. `private.reverse_claim_ledger` is absent from
  the definer-callable warnings because it is plain `SECURITY INVOKER`
  (called from inside `cancel_claim`/`expire_claims`, which already run as
  the owner) and is revoked from every role including `service_role`.
- Migration 0053 (task 2.1: `sweep_campaigns`, the widened
  `campaigns_active_window_idx`, the `campaigns.sweep` cron job) added no new
  advisor of any level. Verified live on 2026-08-06: still 0 ERROR, same WARN
  set. `public.sweep_campaigns` does not appear in the authenticated-callable
  definer warnings, because EXECUTE is granted to `service_role` only and it
  pins `search_path = ''`. The freshly-built index shows as "has not been
  used" on the performance advisor, which is expected of any index checked
  immediately after creation and not itself a finding.
- Migration 0054 (task 2.1 review-fix pass: `sweep_campaigns`'s self-clearing
  WHERE clause and its `raise warning` fix) added no new advisor of any
  level. Verified live on 2026-08-06: still 0 ERROR, same WARN set -
  unsurprising, since `create or replace function` on the same signature
  keeps the same grants and the same `search_path = ''` pin 0053 already
  carried.
- Migration 0055 (task 2.1 second review-fix pass: the aggregate skip
  warning and the new `private.campaigns_sweep_ineligible_count()` helper)
  added no new advisor of any level. Verified live on 2026-08-06: still 0
  ERROR, same WARN set. The new private helper is plain (not `SECURITY
  DEFINER`) and revoked from every role including `service_role`, so it
  never appears in the definer-callable warnings at all; `sweep_campaigns`
  itself keeps its `service_role`-only grant across the `create or replace`.

### `cancel_claim` (0050-0051, task 1.4 + review-fix pass)

A consumer can cancel their own unredeemed claim (`reward_claims.status =
'claimed'`) and get the points back immediately, instead of waiting up to
`rewards.claim_expiry_days` for the hourly sweep - doc 03's loyalty
benchmark research (Key Finding 1) names "points debited on intent and never
returned" as the top complaint driver this closes.

`public.cancel_claim(p_claim_id uuid)` locks the claim row FOR UPDATE first,
exactly where `validate_redemption` takes its own lock, so a concurrent
staff redemption and a concurrent consumer cancel of the SAME claim
serialize on that row and the loser gets a clean typed error
(`CLAIM_ALREADY_REDEEMED` if a redemption won, `CLAIM_ALREADY_CANCELLED` if
a cancel won - `validate_redemption` gained this second branch in the same
migration, ahead of its existing `CLAIM_INVALID_STATE` catch-all). The
reversal itself - the ledger `reversal` row (only when `points_spent > 0`),
the `business_customers.points_balance` cache restore, and the
`rewards.remaining` restore under the `rewards_remaining_lte_total` cap - is
`private.reverse_claim_ledger`, a plain (non-definer) helper now shared with
a refactored `expire_claims`, so the on-demand cancel path and the sweep's
own single-claim reversal cannot drift on what "reverse a claim" means.
`reward_claims.status`'s `'cancelled'` value and its `cancelled_reason`
column both predate this migration (provisioned in 0012, never had a
writer); `cancel_claim` is their first writer, stamping
`cancelled_reason = 'consumer_cancelled'`.

Granted to `authenticated` only (consumer-facing, matching `claim_reward`'s
own shape) - `anon` AND `service_role` are both explicitly revoked (0051,
review fix M6): Supabase's project-level default privileges grant every new
`public`-schema function EXECUTE to `service_role` independently of the
`revoke ... from public` a caller might expect to cover it, so 0050 shipped
with `service_role` able to call this consumer-only action until 0051's
pgTAP grant matrix caught it. Idempotent: a second cancel of an
already-cancelled claim raises `CLAIM_ALREADY_CANCELLED` rather than
double-reversing, and `expire_claims`'s own candidate scan
(`status = 'claimed'`) never re-selects a cancelled claim - even a cancelled
claim whose `expires_at` has ALSO lapsed, which is the case the pgTAP suite
actually proves (a fixture back-dated into the past AFTER being cancelled;
without that, the sweep's own date predicate alone would already return 0
candidates and the assertion would prove nothing about the status filter).
`private.reverse_claim_ledger`'s `p_created_by` parameter (renamed from
`p_actor_id`, 0051 review fix M3 - it is written to
`points_transactions.created_by`, never `.actor_id`) stamps
`business_customers.updated_by` only when given a real actor
(`coalesce(p_created_by, business_customers.updated_by)`, 0051 review fix
M1): `cancel_claim` passes the consumer's `auth.uid()` and so still stamps
it, matching `claim_reward`'s own precedent, while `expire_claims` passes
null and now correctly leaves the column untouched, restoring 0016's real
prior behavior instead of nulling it on every sweep run as 0050 shipped.
Covered by `rpc_claim_smoke.sql` (76 assertions after the review-fix pass).

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
| 0045_points_expiry_fifo_order_and_self_clearing.sql | 20260806050141 | 0045_points_expiry_fifo_order_and_self_clearing |
| 0046_points_expiry_warn_projected_remainder.sql | 20260806050158 | 0046_points_expiry_warn_projected_remainder |
| 0047_points_expiry_append_only_narrow_guard.sql | 20260806054229 | 0047_points_expiry_append_only_narrow_guard |
| 0048_points_expiry_warn_window_stable_ordering.sql | 20260806054312 | 0048_points_expiry_warn_window_stable_ordering |
| 0049_points_expiry_warn_honest_deadline.sql | (applied 2026-08-06) | 0049_points_expiry_warn_honest_deadline |
| 0050_cancel_claim.sql | (applied 2026-08-06) | 0050_cancel_claim |
| 0051_cancel_claim_review_fixes.sql | (applied 2026-08-06) | 0051_cancel_claim_review_fixes |
| 0052_definer_service_role_hygiene.sql | 20260806082050 | 0052_definer_service_role_hygiene |
| 0053_campaigns_sweep.sql | 20260806084550 | 0053_campaigns_sweep |
| 0054_campaigns_sweep_review_fixes.sql | 20260806091451 | 0054_campaigns_sweep_review_fixes |
| 0055_campaigns_sweep_skip_visibility.sql | 20260806093311 | 0055_campaigns_sweep_skip_visibility |
| *(not in this worktree - task 2.2)* | 20260806095729 | 0056_balance_check |
| *(not in this worktree - task 2.2)* | 20260806104108 | 0057_balance_check_review_fixes |
| 0059_job_health_alerts.sql | 20260806110554 | 0058_job_health_alerts |
| *(not in this worktree - task 2.2)* | 20260806111225 | 0058_balance_check_deployment_correction |
| *(not in this worktree - task 2.2)* | 20260806114840 | 0059_balance_check_trigger_privilege_fix |
| 0061_job_health_terminal_failures.sql | 20260806120833 | 0061_job_health_terminal_failures |

**Rows 0001-0035 are from the 2026-07-26 replay onto `zlfxfzlnklqhajacngxf`; rows 0036-0049 were applied later, and 0042-0049 on 2026-08-06.** The
sentence below describes the replay only. It does NOT describe 0042-0049: one
of those (0047) had its *content* reach the database out-of-band BEFORE its own
ledger row existed, which is recorded in the Notes bullet at the end of this
section. Read that bullet before restoring any environment from this ledger.
Every migration was applied in file order in a single pass, so unlike the
first run there is no ordering inversion and no ledger-name drift: live names
match the file base names 1:1, with one exception noted in the table: 0032 was
applied through the MCP tool, which takes a snake_case migration NAME rather
than the file name, so it is recorded as `integration_connections`. The file
is still the source of truth and the ordering is unaffected. 0034 and 0035 were applied the same way and carry the same MCP snake_case names. See "Project history" below for why the replay
happened.

Notes:
- **0056-0058 (task 2.2's three) are not present as files in THIS worktree.**
  Every Wave 2 task works against the same live project through its own
  isolated git worktree, so a migration another task applies live reaches
  this worktree's `supabase/migrations/` only once the branches merge - the
  live ledger (confirmed via `list_migrations` on 2026-08-06) is ahead of
  what this checkout can see. Recorded as three ledger rows with no
  filename rather than silently omitted, so the table stays an honest map of
  what is actually live rather than implying only four migrations exist
  between 0055 and 0059.
- **Two migrations both applied live as `0058_...`.** Task 2.5's
  `job_alert_state` table (authored as `0058_job_health_alerts.sql`) and task
  2.2's deployment correction (`0058_balance_check_deployment_correction`)
  were authored concurrently in separate checkouts and both took file number
  0058. Both are applied live, at distinct timestamps, in the order shown
  above; only the FIRST one's filename was renamed (to `0059`, body
  byte-identical to what ran) so a merged file set has a defined replay
  order. See `supabase/migrations/0059_job_health_alerts.sql`'s own top note
  for the full account - the same drift-gets-written-down rule 0011b and the
  0042/0047 incident both established.
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
- **`points_transactions_append_only`'s fence was genuinely disabled for one
  `UPDATE` statement on 2026-08-06** (0042's backfill), and re-enabled
  immediately after, in the same migration - real history, and 0042 is kept
  exactly as it ran rather than rewritten to describe a guard that came
  later. The permanent narrow guard that now makes this unnecessary for any
  future backfill was installed afterward, as its own migration (`0047`),
  following the identical `0011b` shape: a companion file, not an edit to
  the migration that already ran. A first review-fix pass got this wrong -
  it rewrote 0042 in place and pushed the corrected trigger body live
  out-of-band - which is exactly the mistake `0011b`'s own precedent exists
  to prevent (`supabase db push` compares recorded version/name, not file
  content, so a database that had already run old-0042 would never receive
  a silently-rewritten body). Corrected: 0042 is restored to its real
  history and 0047 records the guard's real arrival, live-applied as the
  no-op it already was by the time this correction shipped.
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
