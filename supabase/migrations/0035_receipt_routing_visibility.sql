-- ============================================================================
-- 0035_receipt_routing_visibility.sql
-- Two halves of the same honesty problem on the receipt money path.
--
--   PART 1 (D10). public.receipt_routing_breakdown: what share of receipts were
--     auto-approved, needed a human, or were rejected over a window, broken
--     down by WHICH rule asked for the human. There are eight independent paths
--     to a review queue and nobody has ever measured what fraction of real
--     receipts trips at least one. This is the measurement.
--
--   PART 2 (D7). public.sweep_stuck_receipts stops dead-lettering our own
--     failures as consumer rejections. Every receipt this sweep can see is one
--     WE failed to process, so `rejected` / `manual` was always the wrong
--     conclusion, and `receipt-copy.ts` turned it into "we could not accept
--     this receipt" for a customer whose photograph was fine.
--
-- Source docs / decisions:
--   * docs/30-modules/36-receipt-ocr-pipeline.md Stage 9 (routing table),
--     Stage 4 and "Retry, timeouts, DLQ".
--   * docs/30-modules/37-fraud-detection.md ("Scoring & routing").
--   * 0028_scheduled_sweeps.sql, which this migration amends in place.
--   * src/features/receipts/server/process.ts, whose `ReviewReason` union is
--     the vocabulary the breakdown counts and whose `handleOcrFailure` is the
--     application-side half of D7.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--
-- It does not add an event stream. `receipts.status` and
-- `parse_meta.review_reasons` already carry every fact the breakdown needs, on
-- the row, written by the one function that made the decision. A parallel
-- table of routing events would be a second source of truth for a number whose
-- entire value is that it is not a guess, and it would be wrong the first time
-- a backfill or a human review moved a receipt without emitting an event.
--
-- It does not add an index. See the note above receipt_routing_breakdown.
--
-- Conventions per 0013 / 0016 / 0018 / 0028: security definer,
-- set search_path = '', fully qualified references, revoke/grant pairing,
-- service_role only.
-- ============================================================================

-- ============================================================================
-- PART 1 - receipt_routing_breakdown (D10)
-- ============================================================================
--
-- WHY A FUNCTION AND NOT A POSTGREST READ. PostgREST cannot group, so the
-- alternative was fetching every receipt row in the window into Node and
-- folding it there. That is a row cap in disguise: the moment the platform view
-- exceeds the cap the number silently becomes a sample, and a sampled review
-- rate is exactly the kind of almost-true number this whole decision exists to
-- stop us from acting on. Aggregating in the database makes it exact at any
-- size and costs one round trip.
--
-- WHY service_role ONLY, with no tenancy check of its own. Identical to the
-- reasoning in src/features/receipts/review/queue.ts and
-- src/features/admin/queue.ts, and it is worth restating because this function
-- takes a business id and could be mistaken for a tenancy boundary. IT IS NOT.
-- 0017's column grant withholds `parse_meta` from `authenticated` and column
-- privileges are role-wide, so no policy can give a merchant this read; the
-- server-side callers hold the fence instead - `resolveReviewerContext()` for
-- the business surface, `resolveAdminContext()` for the platform one - exactly
-- as they already do for the review queue itself. p_business_id NULL means
-- "the whole platform" and is only ever reachable from an admin route.
--
-- WHY created_at IS THE WINDOW. The question is "of the receipts a customer
-- scanned this month, how many needed a person", so the denominator has to be
-- when they SCANNED. `processed_at` would silently drop every receipt still in
-- a queue, which is the population most likely to be in review, and would
-- flatter the review rate precisely when the queue is backing up.
--
-- WHY NO INDEX WAS ADDED. The business-scoped call - the one a merchant loads
-- on every dashboard visit - is served by receipts_biz_status_idx (0017, on
-- business_id, status, created_at desc). The platform-scoped call is one admin
-- page and scans the window; at Giya's size that is cheaper than the write
-- amplification of a fourth index on the hottest table in the schema. Revisit
-- when a seq scan of 30 days of receipts stops being milliseconds, not before.
--
-- THE SHAPE. One narrow relation rather than a wide row, because the two things
-- being reported have different cardinality: there are five statuses and an
-- open-ended list of reasons, and a wide row would need a column added every
-- time `ReviewReason` gains a member. `kind` says which question a row answers:
--
--   kind='status'  key in (approved, review, rejected, pending) - the shares.
--                  queued and processing collapse to 'pending' because the
--                  difference is an implementation detail of the queue and
--                  neither is an outcome yet.
--   kind='reason'  key is one `ReviewReason`, counted over RECEIPTS IN REVIEW
--                  ONLY, plus 'unattributed'.
--
-- REASON COUNTS DO NOT SUM TO THE REVIEW COUNT, and that is correct rather than
-- a rounding problem: a receipt can trip several rules at once and every one of
-- them is a true statement about why a human is looking. Presenting them as
-- shares of a whole would be the lie. The callers say so out loud.
--
-- 'unattributed' IS THE BACKFILL, NAMED. Receipts processed before
-- `parse_meta.review_reasons` existed carry no reason at all. Folding them into
-- any real reason would inflate that reason with rows that are not evidence for
-- it, and dropping them would silently shrink the denominator; either way the
-- dial gets tuned on a number nobody measured. They are counted, separately,
-- under a name that says what they are. The bucket shrinks to nothing on its
-- own as the window rolls forward, which is the point: it is a fact about our
-- history, not a category of receipt.
create or replace function public.receipt_routing_breakdown(
  p_business_id uuid default null,
  p_days integer default 30
)
returns table (
  kind  text,
  key   text,
  tally bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with scoped as (
    select r.status, r.parse_meta
      from public.receipts r
     -- Clamped like every other settings-derived window in this schema: a zero
     -- or negative p_days would return an empty breakdown that reads exactly
     -- like a healthy platform with no receipts.
     where r.created_at >= now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
       and (p_business_id is null or r.business_id = p_business_id)
  ),
  reviewed as (
    select s.parse_meta
      from scoped s
     where s.status = 'review'
  ),
  -- A row is attributed when it carries a non-empty review_reasons ARRAY.
  -- jsonb_typeof is checked rather than assumed: parse_meta is jsonb written by
  -- the application, and a malformed document must degrade this row to
  -- 'unattributed' rather than raise and take the whole breakdown down.
  attributed as (
    select jsonb_array_elements_text(v.parse_meta -> 'review_reasons') as reason
      from reviewed v
     where jsonb_typeof(v.parse_meta -> 'review_reasons') = 'array'
       and jsonb_array_length(v.parse_meta -> 'review_reasons') > 0
  )
  select 'status'::text,
         -- queued and processing are one waiting state, matching
         -- receiptOutcome() in src/features/receipts/components/receipt-copy.ts
         -- so the merchant's panel and the consumer's screen agree on what
         -- "still going" means.
         (case when s.status in ('queued', 'processing') then 'pending'
               else s.status::text end)::text,
         count(*)::bigint
    from scoped s
   group by 2

  union all

  select 'reason'::text, a.reason::text, count(*)::bigint
    from attributed a
   group by a.reason

  union all

  select 'reason'::text, 'unattributed'::text, count(*)::bigint
    from reviewed v
   where jsonb_typeof(v.parse_meta -> 'review_reasons') is distinct from 'array'
      or jsonb_array_length(v.parse_meta -> 'review_reasons') = 0
  having count(*) > 0;
$$;

revoke execute on function public.receipt_routing_breakdown(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.receipt_routing_breakdown(uuid, integer) to service_role;

-- ============================================================================
-- PART 2 - sweep_stuck_receipts stops blaming the customer (D7)
-- ============================================================================
--
-- 0028 wrote this function to land a genuinely dead receipt in doc 36's
-- dead-letter state: rejected / manual / 'processing_failed'. Every word of
-- 0028's reasoning about WHICH receipts it may touch still stands and none of
-- it is changed here - the three conditions, the row lock, the re-asserted
-- status predicate, the settings precedence, the idempotence. What changes is
-- the CONCLUSION, and it changes because of a fact 0028 stated without drawing
-- the consequence from:
--
--   the only receipts this sweep can ever see are ones WE failed to process.
--
-- That follows from the pipeline, not from optimism. A receipt whose IMAGE was
-- the problem never parks: src/features/receipts/server/process.ts
-- `handleOcrFailure` finalizes an unreadable photo immediately, on the attempt
-- that discovered it. The only way to still be at 'processing' hours later is
-- that our OCR call never succeeded - an exhausted Vision quota, a rejected
-- credential, a half-deployed function, a provider outage. Google Cloud Vision's
-- free tier is 1,000 units a month, so the most likely single cause of a full
-- sweep is that we stopped paying, and the old conclusion told every one of
-- those customers "we could not accept this receipt".
--
-- So the terminal state is now REVIEW, with the cause recorded, and a human at
-- the shop decides. The receipt is probably fine; we hold the image; a person
-- can read it. Rejecting is the only outcome that destroys a real purchase, and
-- it did so on the strength of a fact about our billing.
--
-- THREE THINGS THIS DOES NOT CHANGE, deliberately:
--   * WHICH receipts qualify. A receipt still inside its attempt budget, or
--     merely slow, is untouched exactly as before. The sweep still cannot
--     retry, and still never guesses.
--   * The ledger. It writes public.receipts and nothing else; a receipt at
--     'processing' has no earn row by construction (0018 runs only after the
--     terminal 'approved' write), and 'review' awards nothing either.
--   * reviewed_by / reviewed_at stay null. No human decided this, and writing
--     one would put a fiction in the column the review UI reads to tell an
--     automatic outcome from a human one.
--
-- THE ONE RECEIPT THAT STILL GETS REJECTED is one with no business_id. 0017
-- gives no RLS audience a path to such a row, so putting it in 'review' would
-- file it in a queue nobody can open, forever - worse than a rejection, which
-- at least tells the consumer something. `resolveOutcome` in process.ts makes
-- this identical call for this identical reason, and routeToOperatorReview
-- mirrors it on the application side.
--
-- NO NOTIFICATION IS RAISED HERE, and that is a limit rather than a choice.
-- Composing one would mean a second copy of the consumer copy matrix in plpgsql,
-- outside receipt-copy.test.ts's forbidden-vocabulary sweep, which is the exact
-- duplication ../../src/features/receipts/server/notify.ts exists to prevent.
-- The consumer is not left uninformed: `receipts` is a Realtime publication
-- (0020) and both the status screen and the wallet render "The store is checking
-- this" from the status alone. When the jobs slice owns this sweep in
-- TypeScript, the notification comes with it and this comment goes away.
--
-- Returns how many receipts it moved, unchanged, so the pg_cron schedule row
-- and rpc_sweeps_smoke.sql's counting assertions keep their meaning.
create or replace function public.sweep_stuck_receipts(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stuck_hours  integer;
  v_max_attempts integer;
  v_receipt_id   uuid;
  v_business_id  uuid;
  v_swept        integer := 0;
begin
  -- Thresholds are data, not code (doc 37: "defaults live in settings rows
  -- scope='platform', tunable without deploy"). Both reads fall back to the
  -- seeded default rather than failing, and both are clamped, because a
  -- malformed or hostile settings value must not be able to widen the sweep:
  -- a 0-hour window would move every receipt mid-flight, and a 0-attempt
  -- budget would move every receipt that has not yet had a single OCR call.
  select nullif(s.value #>> '{}', '')::integer
    into v_stuck_hours
    from public.settings s
   where s.scope = 'platform'
     and s.key = 'receipts.stuck_processing_hours';
  v_stuck_hours := greatest(coalesce(v_stuck_hours, 24), 1);

  select nullif(s.value #>> '{}', '')::integer
    into v_max_attempts
    from public.settings s
   where s.scope = 'platform'
     and s.key = 'ocr.max_attempts';
  v_max_attempts := greatest(coalesce(v_max_attempts, 3), 1);

  for v_receipt_id, v_business_id in
    select r.id, r.business_id
      from public.receipts r
     where r.status = 'processing'
       and r.updated_at <= now() - make_interval(hours => v_stuck_hours)
       -- Condition 3. Both halves are scalar subqueries so the row lock below
       -- applies to public.receipts alone: neither ocr_results nor settings is
       -- locked by this sweep.
       and coalesce(
             (select max(o.attempt)
                from public.ocr_results o
               where o.receipt_id = r.id),
             0)
           >= coalesce(
                -- Business scope wins, matching the settings loader's own
                -- precedence. A tenant that raised its own retry budget must
                -- not have its receipts declared dead at the platform number.
                (select nullif(bs.value #>> '{}', '')::integer
                   from public.settings bs
                  where bs.scope = 'business'
                    and bs.business_id = r.business_id
                    and bs.key = 'ocr.max_attempts'),
                v_max_attempts)
     order by r.updated_at
     limit p_limit
       for update skip locked
  loop
    if v_business_id is null then
      -- No tenant, so no queue that can see it. The old dead-letter state is
      -- still the least bad answer here and keeps its original note.
      update public.receipts
         set status        = 'rejected',
             reject_reason = 'manual',
             reject_note   = 'processing_failed',
             processed_at  = now()
       where id = v_receipt_id
         and status = 'processing';
    else
      update public.receipts
         set status        = 'review',
             reject_reason = null,
             -- Operator vocabulary, withheld from the client by 0017's column
             -- grant. `sweep` distinguishes this from the application-side
             -- `ocr_operator_failure:{code}` that handleOcrFailure writes, so
             -- "the pipeline gave up" and "nothing ever came back" stay
             -- separable in a post-mortem.
             reject_note   = 'ocr_operator_failure:sweep',
             -- Merged rather than assigned, so a parse_meta some future stage
             -- wrote before dying is not erased by the sweep. The review queue
             -- reads `review_reasons` to tell the reviewer why this receipt is
             -- in front of them, and an unexplained empty receipt is the most
             -- confusing row that queue can hold.
             parse_meta    = coalesce(parse_meta, '{}'::jsonb)
                             || jsonb_build_object('review_reasons',
                                                   '["ocr_operator_failure"]'::jsonb),
             processed_at  = now()
       where id = v_receipt_id
         and status = 'processing';
    end if;

    if found then
      v_swept := v_swept + 1;
    end if;
  end loop;

  return v_swept;
end
$$;

-- Unchanged from 0028, restated because `create or replace` does not carry
-- grants forward on a signature change and restating them is cheaper than
-- checking every time. System sweep, service_role ONLY: no consumer and no
-- staff member may move a receipt by calling this.
revoke execute on function public.sweep_stuck_receipts(integer) from public, anon, authenticated;
grant execute on function public.sweep_stuck_receipts(integer) to service_role;
