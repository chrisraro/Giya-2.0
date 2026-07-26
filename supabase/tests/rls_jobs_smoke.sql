-- ============================================================================
-- rls_jobs_smoke.sql (pgTAP)
-- Smoke tests for 0029 jobs: the service-role-only fence (no policies at all,
-- and privileges revoked underneath so the denial is loud), the service_role
-- privilege split, the no-truncate statement trigger, the partial dedupe index
-- in both directions (it blocks an in-flight duplicate and it does NOT block a
-- re-enqueue after the first one died), the shape check on `queue`, the status
-- vocabulary, the two lifecycle constraints, and doc 39's claim protocol.
--
-- Runs entirely inside one transaction and rolls back. Execute as a privileged
-- role (postgres) against a database with migrations 0001-0029 applied. pgTAP
-- lives in the extensions schema.
--
-- HARD RULE, carried over from the receipts, audit and notifications suites:
-- every fixture id is captured off its own "insert ... returning" CTE. Nothing
-- is looked up by name, by queue or by any other global predicate over the
-- table - this database also holds live data, and a real job sharing a
-- fixture's queue name would silently be picked up instead of the fixture's own
-- row. Every count assertion below is scoped by a fixture id.
--
-- `jobs` has no foreign keys at all (business_id is deliberately unconstrained,
-- per 0029), so unlike the other suites this one needs no auth.users, no
-- profiles and no tenant: the fixtures are the job rows themselves.
--
-- Note on the "queue name" the fixtures use: `test.smoke` satisfies 0029's
-- shape check and is not in doc 39's registry, which is exactly right. The
-- registry is enforced in src/lib/queue/queues.ts, not by the database (see
-- 0029's comment on the `queue` column for why), so a fixture may use a name no
-- worker serves without pretending to be one that is served.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(25);

-- ---------------------------------------------------------------- fixtures
-- Three job rows, all captured from one insert-returning CTE:
--   j1 - queued, dedupe_key 'alpha'. The in-flight row.
--   j2 - dead, dedupe_key 'beta'. The finished row whose key must be free.
--   j3 - queued, NO dedupe key. The undeduplicated sweep-shaped row.
with ins as (
  insert into public.jobs
    (queue, status, payload, dedupe_key, attempts, started_at, finished_at, last_error)
  values
    ('test.smoke', 'queued', '{"marker": "j1"}'::jsonb, 'alpha', 0, null, null, null),
    ('test.smoke', 'dead',   '{"marker": "j2"}'::jsonb, 'beta',  5,
       now() - interval '5 minutes', now(), 'provider refused five times'),
    ('test.smoke', 'queued', '{"marker": "j3"}'::jsonb, null,    0, null, null, null)
  returning id, payload
)
select
  set_config('test.j1', (select id::text from ins where payload->>'marker' = 'j1'), true),
  set_config('test.j2', (select id::text from ins where payload->>'marker' = 'j2'), true),
  set_config('test.j3', (select id::text from ins where payload->>'marker' = 'j3'), true);

-- ---------------------------------------------------------------- the fence
-- 0029's whole argument: a client asking about the work queue gets an ERROR,
-- not an empty set. Zero rows is what a healthy queue looks like to someone who
-- is allowed to look, so returning it to someone who is not would be the wrong
-- answer dressed as the right one.

set local role authenticated;

-- 1.
select throws_ok(
  $$select id from public.jobs$$,
  '42501',
  null,
  'authenticated cannot select jobs at all (table grant revoked)');

-- 2. A forged job row is the attack this table's fence exists for: an insert
--    here is an instruction to a worker running as the service role.
select throws_ok(
  $$insert into public.jobs (queue, payload) values ('ocr.process', '{}'::jsonb)$$,
  '42501',
  null,
  'authenticated cannot enqueue a job');

-- 3. and cannot edit one. Flipping a job to 'succeeded' would silently cancel
--    work that never ran.
select throws_ok(
  $$update public.jobs set status = 'succeeded'
     where id = current_setting('test.j1')::uuid$$,
  '42501',
  null,
  'authenticated cannot update a job');

-- 4.
select throws_ok(
  $$delete from public.jobs where id = current_setting('test.j1')::uuid$$,
  '42501',
  null,
  'authenticated cannot delete a job');

reset role;

set local role anon;

-- 5. doc 12 requires the anon row of the matrix stated explicitly rather than
--    inferred from "no policy".
select throws_ok(
  $$select id from public.jobs$$,
  '42501',
  null,
  'anon cannot select jobs');

-- 6.
select throws_ok(
  $$insert into public.jobs (queue, payload) values ('notify.email', '{}'::jsonb)$$,
  '42501',
  null,
  'anon cannot enqueue a job');

reset role;

-- ---------------------------------------------------------------- privileges
-- RLS gates row DML only. It never sees TRUNCATE and it never applies to
-- service_role, so the privilege layer is the only fence for both. Each
-- assertion aggregates the privileges a role actually still holds into a sorted
-- string, so a failure names the exact privilege that leaked.

-- 7.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('anon', 'public.jobs', p)),
  null::text,
  'anon holds no privilege at all on jobs');

-- 8.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('authenticated', 'public.jobs', p)),
  null::text,
  'authenticated holds no privilege at all on jobs');

-- 9. The service_role split: the whole lifecycle stays (enqueue, claim, finish,
--    and the operator read behind the Queue Status screen), deletion does not.
--    Doc 39's answer to a bad job is status='dead', which IS the DLQ view, and
--    its answer to a fixed one is replay under the same id. A queue you can
--    delete rows from cannot answer "did that ever run".
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('service_role', 'public.jobs', p)),
  'INSERT,SELECT,UPDATE',
  'service_role keeps select, insert and update on jobs but not delete or truncate');

-- 10. RLS is on. With zero policies that is a deny-all, and it is enabled so
--     that the absence of a policy reads as a decision rather than an
--     oversight.
select is(
  (select relrowsecurity from pg_class
    where oid = 'public.jobs'::regclass),
  true,
  'row level security is enabled on jobs');

-- 11. and there genuinely are none. This is the assertion that fails the day
--     somebody adds a well-meaning "staff can see their own tenant's jobs"
--     policy without reading 0029's header.
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'jobs'),
  0,
  'jobs has no RLS policies at all (service-role zone)');

-- 12. The statement trigger, which is the layer that survives the revoke being
--     undone. Runs as the privileged role on purpose: the revoke above already
--     stops every role that exists, so this catches the future misgrant.
select throws_ok(
  $$truncate public.jobs$$,
  'P0001',
  null,
  'jobs cannot be truncated (statement-level trigger)');

-- ---------------------------------------------------------------- dedupe
-- The index doc 39's enqueue step 1 depends on, tested in BOTH directions,
-- because getting it wrong in either one is silent.

-- 13. Two in-flight jobs cannot share a key. This is "no double-publish".
select throws_ok(
  $$insert into public.jobs (queue, status, payload, dedupe_key)
    values ('test.smoke', 'queued', '{"marker": "dup"}'::jsonb, 'alpha')$$,
  '23505',
  null,
  'a second queued job cannot take an in-flight dedupe key (jobs_dedupe_idx)');

-- 14. Nor can a 'running' one, which is the half that matters under a race: the
--     duplicate arrives while the first job is being worked, not while it waits.
select throws_ok(
  $$insert into public.jobs (queue, status, payload, dedupe_key, attempts, started_at)
    values ('test.smoke', 'running', '{"marker": "dup"}'::jsonb, 'alpha', 1, now())$$,
  '23505',
  null,
  'a running job cannot take an in-flight dedupe key either');

-- 15. THE OTHER DIRECTION. j2 is dead and holds 'beta'. If the index window
--     were all of history rather than queued/running, this insert would fail
--     and a receipt that failed OCR could never be re-enqueued - the failure
--     mode nobody notices, because the enqueue call is fail-soft.
select lives_ok(
  $$insert into public.jobs (queue, status, payload, dedupe_key)
    values ('test.smoke', 'queued', '{"marker": "requeue"}'::jsonb, 'beta')$$,
  'a dead job does not hold its dedupe key against a re-enqueue');

-- 16. The same key on a DIFFERENT queue is a different job. The index leads
--     with `queue` for exactly this: a receipt id is the ocr.process key and
--     could equally be a notify.email key.
select lives_ok(
  $$insert into public.jobs (queue, status, payload, dedupe_key)
    values ('test.other', 'queued', '{"marker": "other"}'::jsonb, 'alpha')$$,
  'the same dedupe key on another queue is not a duplicate');

-- 17. Undeduplicated jobs coexist. Nulls are distinct in a unique index, which
--     is the behaviour the `dedupe_key is not null` half of the predicate makes
--     explicit rather than relies on.
select lives_ok(
  $$insert into public.jobs (queue, status, payload, dedupe_key)
    values ('test.smoke', 'queued', '{"marker": "nokey"}'::jsonb, null)$$,
  'two jobs with no dedupe key do not collide');

-- ---------------------------------------------------------------- constraints

-- 18. `queue` becomes a URL path segment. An unconstrained one is a path
--     traversal waiting for a careless publisher.
select throws_ok(
  $$insert into public.jobs (queue, payload)
    values ('../../admin', '{}'::jsonb)$$,
  '23514',
  null,
  'a queue name that is not area.name is rejected (shape check)');

-- 19. The status vocabulary is closed by the protocol: the claim UPDATE, the
--     DLQ view and the reconciler are all written against these five, so a
--     sixth value would be a row no worker can finish.
select throws_ok(
  $$insert into public.jobs (queue, status, payload)
    values ('test.smoke', 'paused', '{}'::jsonb)$$,
  '23514',
  null,
  'an unregistered job status is rejected');

-- 20. A terminal row has finished. Without this a crashed finish leaves
--     'succeeded' with a null finished_at and the duration metric silently
--     drops its slowest jobs.
select throws_ok(
  $$insert into public.jobs (queue, status, payload, attempts, started_at)
    values ('test.smoke', 'succeeded', '{}'::jsonb, 1, now())$$,
  '23514',
  null,
  'a terminal job must carry finished_at (jobs_terminal_finished_at)');

-- 21. and a non-terminal one has not finished.
select throws_ok(
  $$insert into public.jobs (queue, status, payload, finished_at)
    values ('test.smoke', 'queued', '{}'::jsonb, now())$$,
  '23514',
  null,
  'a queued job cannot already carry finished_at');

-- 22. THE OTHER HALF of the same constraint, and the one that is easy to get
--     wrong: 'failed' is NOT terminal. Doc 39's failure taxonomy has the
--     retryable class write status='failed' and return a 5xx so QStash delivers
--     again, and the claim predicate is `status in ('queued','failed')` exactly
--     so the next delivery picks it up. A failed job is a job BETWEEN attempts,
--     so it must be allowed to carry no finished_at; requiring one here would
--     make every retryable failure violate a constraint at the worst moment.
select lives_ok(
  $$insert into public.jobs (queue, status, payload, attempts, started_at, last_error)
    values ('test.smoke', 'failed', '{"marker": "retryable"}'::jsonb, 1,
            now() - interval '1 minute', 'provider timed out')$$,
  'a failed job may carry no finished_at (failed is between attempts, not terminal)');

-- 23. attempts and started_at move together, because doc 39's claim writes them
--     in one UPDATE.
select throws_ok(
  $$insert into public.jobs (queue, status, payload, attempts)
    values ('test.smoke', 'queued', '{}'::jsonb, 3)$$,
  '23514',
  null,
  'attempts without started_at is rejected (jobs_started_at_attempts)');

-- ---------------------------------------------------------------- claim
-- Doc 39's worker step 3, verbatim. The predicate `status in ('queued','failed')`
-- is what makes a duplicate QStash delivery a no-op instead of a second run,
-- and it is the only thing that does: the dedupe index stops two JOBS existing
-- and stops nothing about two DELIVERIES of one job.

-- 24. The first delivery claims it.
-- The WITH has to be at the TOP level: Postgres refuses a data-modifying CTE
-- inside a scalar subquery (0A000), so the claim cannot be tucked into is()'s
-- first argument the way every other assertion here tucks its query.
with claimed as (
  update public.jobs
     set status = 'running', attempts = attempts + 1, started_at = now()
   where id = current_setting('test.j3')::uuid
     and status in ('queued', 'failed')
  returning id
)
select is(
  (select count(*)::int from claimed),
  1,
  'the first delivery claims a queued job (doc 39 claim protocol)');

-- 25. The second finds nothing to claim, which is how the worker learns the job
--     is already owned and returns 200 without doing the work twice.
with claimed as (
  update public.jobs
     set status = 'running', attempts = attempts + 1, started_at = now()
   where id = current_setting('test.j3')::uuid
     and status in ('queued', 'failed')
  returning id
)
select is(
  (select count(*)::int from claimed),
  0,
  'a duplicate delivery claims nothing (the claim is the idempotency gate)');

select * from finish();

rollback;
