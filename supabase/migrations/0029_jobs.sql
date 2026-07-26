-- ============================================================================
-- 0029_jobs.sql
-- `jobs`: the durable mirror of every queued unit of work.
--
-- Source docs: docs/20-data/25-schema-platform.md (the canonical DDL and both
-- indexes), docs/30-modules/39-background-jobs.md (the whole contract: the
-- status vocabulary, the dedupe rule, the claim protocol, max_attempts, the
-- DLQ, the reconciler), docs/10-architecture/12-multi-tenancy-rls.md (the
-- service-role zone).
--
-- ---------------------------------------------------------------------------
-- THE ONE IDEA
-- ---------------------------------------------------------------------------
-- Doc 39: "Postgres is the truth. Losing QStash or Redis loses delivery/speed,
-- never state." Every enqueue writes this row BEFORE it publishes, so a crash
-- between the insert and the publish leaves a `queued` row that the reconciler
-- can re-publish. The corollary is that this table is worthless if it is not
-- believed: a job row that a client could invent, edit or delete would make
-- "Postgres is the truth" a slogan rather than a property.
--
-- Hence the fence, which is the strictest in this schema so far.
--
-- ---------------------------------------------------------------------------
-- THE FENCE: SERVICE ROLE ONLY, AND NO POLICIES AT ALL
-- ---------------------------------------------------------------------------
-- 0017's `receipts` and 0026's `notifications` both have client policies,
-- because both have a legitimate client audience. This table has none. Every
-- reader and every writer of `jobs` is a worker or an operator surface running
-- under the service role (doc 39: "Workers are stateless, idempotent,
-- service-role zone"), and the admin portal's Queue Status screen reads it the
-- same way for the reason 0017 and 0022 both give - the claim-based admin
-- predicate is not usable on this project.
--
-- So RLS is enabled with ZERO policies, which denies every row to every client
-- role, and the privileges are revoked underneath it so the denial is a loud
-- 42501 rather than a silent empty set. Both layers, on purpose: a policy-less
-- RLS table answers `select` with zero rows, and zero rows is exactly what a
-- healthy queue looks like to someone who is not allowed to see it. An error is
-- the honest answer to "may I read the work queue", and it is the answer a
-- future `grant select ... to authenticated` typed in a hurry cannot undo on
-- its own.
--
-- What a leaked read would cost, stated so the fence is not cargo cult:
-- `payload` carries receipt ids, user ids and business ids; `last_error` is raw
-- provider text and is exactly the class of string doc 15 keeps away from
-- clients (it can carry an upstream URL, a row id, a stack frame). Doc 39 also
-- has `fraud.ring_sweep` and `integrity.balance_check` publishing through this
-- same table, so a readable `jobs` would eventually be a readable schedule of
-- when the fraud sweeps run.
--
-- DELETE and TRUNCATE go for service_role too, mirroring 0022's ledger-style
-- revoke. Doc 39's operational answer to a bad job is `status='dead'` (the DLQ
-- view) and its answer to a fixed one is replay with the SAME job id, never
-- deletion; and retention here is not a per-row policy the way 0026's is, it is
-- a bulk sweep that does not exist yet. A queue you can delete rows from is a
-- queue that cannot answer "did that ever run".
--
-- ---------------------------------------------------------------------------
-- Environment adaptations, same family as 0002/0007/0012/0017/0022/0026:
--   * uuid_generate_v7() -> private.uuid_generate_v7()
--   * no PG enums: status is text + a check constraint
--   * no claim-based admin policy (see above)
-- ============================================================================

-- ============================================================ jobs
create table public.jobs (
  id           uuid primary key default private.uuid_generate_v7(),

  -- The queue name from doc 39's canonical registry ('ocr.process',
  -- 'notify.email', 'campaigns.sweep', ...). Deliberately NOT a check
  -- constraint, and this is the 0022 call rather than the 0026 one.
  --
  -- 0026 enumerated `notifications.kind` because a notification write is
  -- fail-soft: an unlisted value costs one message. An enqueue is not. It is
  -- the first statement of the work, and doc 39 has `ocr.process` enqueued
  -- inside receipt submission, so a forgotten enum migration would answer a
  -- new queue with 23514 and take down whatever was trying to schedule it -
  -- exactly the argument 0022 made for `audit_logs.action`. The registry is
  -- doc 39 plus src/lib/queue/queues.ts, which is where an unknown queue is
  -- refused, in the one place that can refuse it without breaking anything.
  --
  -- The SHAPE is still constrained, because a queue name becomes a URL path
  -- segment (`/api/jobs/{queue}`) and an unconstrained one would be a path
  -- traversal waiting for a careless publisher.
  queue        text not null check (queue ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),

  -- Doc 39's five states. Enumerated here, unlike `queue`, because this
  -- vocabulary is closed by the protocol itself: the claim UPDATE, the DLQ
  -- view and the reconciler are all written against these exact five, so a
  -- sixth value would not be a new feature, it would be a row no worker can
  -- ever finish.
  status       text not null default 'queued' check (status in
                 ('queued','running','succeeded','failed','dead')),

  -- Identifiers, never denormalized state. Doc 39, `ocr.process`: "the worker
  -- re-reads everything else from the receipts row; payloads carry
  -- identifiers, never denormalized state that can go stale." A payload that
  -- carried a receipt's total would be a second copy of the money, and the
  -- retry three hours later would use the stale one.
  payload      jsonb not null,

  -- The tenant this work belongs to, for the per-tenant flow control keys and
  -- for the admin Queue Status filter. No FK, matching audit_logs (0022): a
  -- job row outliving a hard-purged tenant is a fact about what ran, and a
  -- cascade here would delete the record of the work rather than the work.
  business_id  uuid,

  -- The idempotency key of the ENQUEUE, distinct from the idempotency of the
  -- WORK. See jobs_dedupe_idx below.
  dedupe_key   text,

  attempts     integer not null default 0 check (attempts >= 0),
  -- Doc 39: default 5 total attempts, `retries` on publish = max_attempts - 1.
  -- Bounded above as well as below: QStash's own `retries` parameter is
  -- capped, and a job configured with 500 attempts would not retry 500 times,
  -- it would silently disagree with the message it published.
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),

  -- The last failure's message. OPERATOR VOCABULARY, never consumer-facing:
  -- it is raw upstream text and the client fence above is what keeps it that
  -- way. Same standing as receipts.reject_note, which 0017 withholds by column
  -- grant for the same reason.
  last_error   text,

  -- When the job becomes eligible. `now()` for an immediate enqueue; a future
  -- timestamp for doc 39's jittered fan-out (`delay = random(0..120s)` per
  -- chunk) and for delayed publishes. This is also the column the "age of
  -- oldest queued job" metric measures from (doc 39, Observability).
  scheduled_at timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz not null default now(),

  -- Doc 39's accepted schema deltas (A25.2 in docs/20-data/26-schema-amendments.md).
  --
  -- qstash_message_id correlates a row with QStash's own DLQ. It is nullable
  -- and stays null on two real paths, both of which matter: an enqueue that
  -- wrote the row and could not reach QStash (the crash window this table
  -- exists to survive), and a job published with no credentials configured at
  -- all. Null therefore means "not published", which is precisely the
  -- predicate the reconciler needs, so it is load-bearing rather than missing.
  qstash_message_id text,

  -- heartbeat_at is doc 39's liveness signal for long jobs. Postgres, not
  -- Redis, for the rows that matter: doc 39 puts the beat in Redis with a TTL
  -- and that is right for the 20-second refresh, but the RECLAIM decision
  -- ("this running job is orphaned") is a state transition, and doc 39's own
  -- first principle is that state lives here. A reclaim that depends on Redis
  -- being up is a reclaim that cannot run during the outage that caused the
  -- orphan.
  heartbeat_at timestamptz,

  -- Two invariants the protocol relies on, stated as constraints because every
  -- one of them is something a half-written worker would otherwise leave
  -- behind and no reader would notice.
  --
  -- A terminal row has finished; a non-terminal one has not. Without this a
  -- crashed finish leaves `succeeded` with a null finished_at, and the p95
  -- duration metric (doc 39, Observability) silently drops its slowest jobs -
  -- the only ones anybody wants to see.
  --
  -- 'failed' is NOT terminal and that is doc 39's word, not a shortcut: its
  -- failure taxonomy has the retryable class write `status='failed'` and return
  -- a 5xx so QStash delivers again, and the claim predicate is `status in
  -- ('queued','failed')` precisely so the next delivery can pick it up. A
  -- failed job is a job between attempts. `dead` is the terminal one, and it is
  -- what the DLQ view renders.
  constraint jobs_terminal_finished_at check (
    (status in ('succeeded','dead')) = (finished_at is not null)
  ),
  -- A job that has been claimed has been started, and one that never has, has
  -- not. `attempts` is incremented by the same UPDATE that sets started_at
  -- (doc 39's claim), so the two cannot legitimately disagree.
  constraint jobs_started_at_attempts check (
    (attempts = 0) = (started_at is null)
  )
);
alter table public.jobs enable row level security;

-- ---------------------------------------------------------------- indexes

-- THE DEDUPE INDEX, verbatim from doc 25 and the mechanism doc 39's enqueue
-- step 1 names ("ON CONFLICT on (queue, dedupe_key) where queued/running ->
-- return existing job, no double-publish").
--
-- Read the predicate carefully, because the two halves do different jobs:
--
--   `dedupe_key is not null`  - a job MAY be undeduplicated. Sweeps that are
--     genuinely fire-and-forget pass no key, and without this half every one
--     of them would collide with every other on `(queue, null)`... except it
--     would not, because nulls are distinct in a unique index, which is
--     exactly the subtle non-behaviour worth writing down rather than relying
--     on. Stated explicitly so the index means what it looks like it means.
--
--   `status in ('queued','running')` - the window is the IN-FLIGHT one, not
--     all of history. This is the whole design and it is easy to get wrong in
--     both directions. Widen it to every status and a receipt that failed OCR
--     could never be re-enqueued, because its dead job would own the key
--     forever. Drop it entirely and two concurrent submissions of the same
--     receipt both enqueue, and doc 39's "no double-publish" is gone.
--
-- What this index is NOT: the guarantee that the WORK happens once. It stops
-- two JOBS existing, and it stops nothing else - a single job delivered twice
-- by QStash is normal and expected. That guarantee is the worker's, via the
-- claim protocol plus a domain key (`pt_receipt_earn_once` for the award, the
-- notification's own delivery status for a send). Two independent mechanisms
-- because they fail independently.
create unique index jobs_dedupe_idx on public.jobs (queue, dedupe_key)
  where dedupe_key is not null and status in ('queued','running');

-- Doc 25's operational index: the reconciler's scan ("queued rows older than
-- 10 min"), the per-queue depth and oldest-age metrics, and the Queue Status
-- screen's filter. Leading (queue, status) with scheduled_at last serves all
-- three as an index-only range scan.
create index jobs_queue_status_idx on public.jobs (queue, status, scheduled_at);

-- Doc 39's accepted `jobs_dead_idx` (A25.2). The DLQ view, and the query
-- behind the alert doc 39 registers ("any queue with >0 dead jobs in 15 min").
-- Partial because dead is the small set on a healthy platform, and it stays
-- small even as the table grows, so the alert costs one probe of a few pages
-- rather than a scan proportional to everything that ever succeeded.
create index jobs_dead_idx on public.jobs (queue, finished_at desc)
  where status = 'dead';

-- The tenant filter on the Queue Status screen, and the FK-shaped index doc
-- 20's conventions ask for even though business_id carries no FK here.
-- Partial: platform-wide jobs (sweeps, rollups) are null and are never the
-- subject of a per-tenant question.
create index jobs_business_idx on public.jobs (business_id, created_at desc)
  where business_id is not null;

-- ---------------------------------------------------------------- policies
-- NONE. Deliberately, and the table comment above is the argument. RLS is
-- enabled so that the absence of a policy is a DENY rather than an oversight
-- (a table with RLS off and no grants would deny too, but for a reason that
-- silently reverses if someone re-grants).

-- ---------------------------------------------------------------- fence 1 of 3
-- Privilege layer, client roles. Supabase grants every privilege on a new
-- public table to anon and authenticated, so without this a client would reach
-- RLS and get a polite empty set. Revoked so it gets 42501 instead: "you may
-- not look at this" and "there is nothing here" are different answers and only
-- one of them is true.
revoke select, insert, update, delete, truncate on public.jobs from anon, authenticated;

-- ---------------------------------------------------------------- fence 2 of 3
-- Privilege layer, service_role. SELECT / INSERT / UPDATE stay: that is the
-- entire lifecycle (enqueue, claim, finish) and the operator's read.
--
-- DELETE and TRUNCATE go, mirroring 0012's ledger revoke and 0017's evidence
-- revoke. Doc 39 has no operation that deletes a job: a bad one becomes
-- `dead` (which IS the DLQ view the admin screen renders) and a fixed one is
-- replayed under its original id so the attempt history stays attached to it.
revoke delete, truncate on public.jobs from service_role;

-- ---------------------------------------------------------------- fence 3 of 3
-- Statement trigger, restating the TRUNCATE revoke at the layer that survives
-- a re-grant. Same shape as 0022's and 0026's, and here for the same reason:
-- the revoke covers the roles that exist today, and a row-level trigger never
-- fires on TRUNCATE at all.
create or replace function private.jobs_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'jobs cannot be truncated (Postgres is the queue''s truth, doc 39)';
end
$$;

create trigger jobs_no_truncate
  before truncate on public.jobs
  for each statement execute function private.jobs_no_truncate();
