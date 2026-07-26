-- ============================================================================
-- 0030_notification_delivery.sql
-- The four delivery columns 0026 deliberately withheld, arriving with the
-- worker that writes them.
--
-- 0026's header made a promise: `channel`, `status`, `sent_at` and `error` are
-- "fields a send records, with no send to record them", and "all arrive with
-- the slice that can write them, together, in one migration with the worker
-- that owns them". This is that migration. The worker is
-- src/workers/notify/email.ts, reached through /api/jobs/notify.email.
--
-- (`campaign_id`, the fifth withheld column, is still absent. It belongs to
-- marketing fan-out, which still does not exist, and 0026's argument against a
-- nullable FK nothing can populate has not changed.)
--
-- Source docs: docs/30-modules/30-platform-core.md section 5.1 ("one row per
-- recipient PER CHANNEL per message"), 5.2 step 3-4 (rows inserted
-- `status='pending'`, `in_app` sent immediately, workers write
-- status/sent_at/error), 5.5 (preference enforcement re-checked at send time),
-- 5.7 (retention differs by channel); docs/20-data/25-schema-platform.md (the
-- canonical column list and the `channel = 'in_app'` conjunct on the unread
-- index); docs/30-modules/39-background-jobs.md, `notify.email` ("worker sends
-- only rows still pending, updating status/sent_at/error per row - a replayed
-- batch re-sends nothing already sent").
--
-- ---------------------------------------------------------------------------
-- WHY A ROW PER CHANNEL RATHER THAN A FLAG ON THE MESSAGE
-- ---------------------------------------------------------------------------
-- The alternative was one row with `emailed_at` beside `read_at`. It is
-- smaller and it is wrong, for a reason that only shows up on the second
-- channel: delivery state is PER CHANNEL, so a single row would need a status,
-- a sent_at and an error for each of them, and adding push later would mean
-- three more columns rather than one more value. Doc 30 section 5.1 settled
-- this and the retention rule in 5.7 depends on it (in_app rows expire on read
-- age, sent rows on terminal age).
--
-- The cost of that choice is one predicate: the inbox and the badge now say
-- `channel = 'in_app'`, because an email row is not a message in the inbox and
-- must never inflate the unread count. Doc 25 already wrote the unread index
-- that way; 0026 dropped the conjunct only because the column did not exist,
-- and noted that it would be "re-created with the conjunct restored and no
-- query changes". The index is restored below. The query change turned out to
-- be real rather than none, and it is in src/features/notifications/server/
-- repo.ts.
--
-- ---------------------------------------------------------------------------
-- THE TRIGGER WIDENS, AND ONLY BY THE THREE COLUMNS A SEND OWNS
-- ---------------------------------------------------------------------------
-- 0026's fence 3 raises on any UPDATE that changes anything but `read_at`, and
-- its comment anticipated exactly this: "UPDATE stays: reserved for the
-- delivery slice's status writes, and harmless today because fence 3 pins
-- every column but read_at regardless of who the writer is." Today it stops
-- being harmless, so the function is replaced with a version that also permits
-- `status`, `sent_at` and `error`.
--
-- Nothing else moves. `channel` joins the immutable list rather than the
-- writable one - a row's channel is what it is, and a send that could rewrite
-- it could turn an email receipt into an inbox message nobody was ever shown.
-- The recipient's reach does not widen at all: the column grant (0026 fence 2)
-- still names `read_at` and only `read_at`, so `authenticated` cannot write
-- any of the three. Every assertion in supabase/tests/rls_notifications_smoke.sql
-- still holds, deliberately - including the one that pins the column grant to
-- exactly `read_at`, which is the assertion that would catch this migration
-- getting it wrong.
-- ============================================================================

-- ---------------------------------------------------------------- columns
alter table public.notifications
  -- Doc 30 section 5.1. `in_app` is the default because it is what every row
  -- written before this migration is, and what raise.ts writes unless it is
  -- told otherwise. 'push' is listed although nothing writes it: the value set
  -- is the vocabulary of the CHANNEL registry (doc 30 section 5.3), not an
  -- inventory of what shipped, and unlike `kind` an unlisted channel cannot be
  -- introduced by a copy edit.
  add column channel text not null default 'in_app'
    check (channel in ('in_app','push','email')),

  -- Doc 30 section 5.2 step 3: rows are inserted `pending` and the worker
  -- moves them. `in_app` rows are `sent` at insert (there is no send to wait
  -- for), which raise.ts writes explicitly rather than relying on a default,
  -- because a default that is right for one channel and wrong for the other
  -- two is a trap.
  --
  -- 'read' is NOT a value here, and that is 0026's decision restated rather
  -- than an omission. Doc 25 lists it, but read state is `read_at`: one
  -- column, one meaning. A parallel `status='read'` would be a second answer
  -- to the same question, reachable only by widening the recipient's write
  -- grant onto a delivery column they could then set to 'failed'.
  --
  -- 'delivered' IS listed although only a webhook could ever write it, because
  -- unlike 'read' it is a genuinely different fact from 'sent' (accepted by
  -- the provider vs accepted by the mailbox) and the day a Resend webhook
  -- lands it must not need a migration to say so.
  add column status text not null default 'pending'
    check (status in ('pending','sent','delivered','failed')),

  add column sent_at timestamptz,

  -- The provider's failure text. OPERATOR VOCABULARY, exactly like
  -- jobs.last_error and receipts.reject_note: it is raw upstream string and it
  -- is withheld from the recipient by 0026's column grant, which this
  -- migration does not touch.
  add column error text;

-- Every row that exists today is an in_app row that was delivered the instant
-- it was written, because until this migration in_app was the only channel and
-- the row WAS the delivery. Backfilling them to 'pending' would be a lie that
-- the retention sweep (doc 30 section 5.7) would eventually act on.
--
-- `sent_at = created_at` rather than `now()`: these were delivered when they
-- were written, and stamping them with the migration's clock would put a
-- future timestamp on messages people have already read.
update public.notifications
   set status = 'sent',
       sent_at = created_at
 where channel = 'in_app'
   and status = 'pending';

-- ---------------------------------------------------------------- indexes
-- Doc 25's unread index, with the `channel = 'in_app'` conjunct restored now
-- that the column exists. This is the badge, read on every consumer page load,
-- and it is the index whose predicate must agree with the query in repo.ts:
-- an email row sitting `read_at is null` (which every email row does forever,
-- since nobody marks an email read) would otherwise be counted as an unread
-- message in an inbox it does not appear in.
drop index if exists public.notifications_user_unread_idx;
create index notifications_user_unread_idx on public.notifications (user_id)
  where read_at is null and channel = 'in_app';

-- The worker's and the retention sweep's index: pending sends to make, and
-- terminal non-inbox rows old enough to purge (doc 30 section 5.7 counts those
-- from 180 days in terminal status, not from read age). Partial over the
-- non-inbox channels so it stays proportional to what is actually being
-- delivered rather than to the whole message history.
create index notifications_delivery_idx on public.notifications (status, created_at)
  where channel <> 'in_app';

-- ---------------------------------------------------------------- fence
-- 0026's fence 3, widened by exactly three columns. See the header.
--
-- `is distinct from` throughout, unchanged and for the unchanged reason:
-- business_id, data and read_at are nullable and `null <> null` is null, which
-- would let a null-to-value change slip past the guard.
create or replace function private.notifications_read_at_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.business_id is distinct from old.business_id
     or new.kind is distinct from old.kind
     or new.channel is distinct from old.channel
     or new.title is distinct from old.title
     or new.body is distinct from old.body
     or new.data is distinct from old.data
     or new.created_at is distinct from old.created_at then
    raise exception
      'notifications is immutable except read_at and delivery state (the message is what was sent)';
  end if;
  return new;
end
$$;
