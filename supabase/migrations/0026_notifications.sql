-- ============================================================================
-- 0026_notifications.sql
-- notifications: one row per recipient per message, written server-side from
-- real domain events, read by the recipient, marked read by the recipient and
-- by nobody else.
--
-- Source docs: docs/20-data/25-schema-platform.md (canonical DDL and the two
-- user indexes), docs/30-modules/30-platform-core.md section 5 (the service,
-- the kind registry, read state, retention), docs/30-modules/33-consumer-pwa.md
-- ("Notifications inbox (/notifications) [MVP]": unread badge, mark-read on
-- open), docs/30-modules/36-receipt-ocr-pipeline.md Stage 10 (approval enqueues
-- kind='points_awarded', rejection enqueues kind='receipt_rejected'),
-- docs/30-modules/37-fraud-detection.md (consequences ladder step 1 notifies on
-- rejection), docs/30-modules/39-background-jobs.md (the notify.push /
-- notify.email queues this table feeds, and cleanup.notifications retention),
-- docs/10-architecture/12-multi-tenancy-rls.md (P2).
--
-- Environment adaptations, same family as 0002/0007/0012/0017/0022:
--   * uuid_generate_v7() -> private.uuid_generate_v7()
--   * no PG enums: kind is text + a check constraint
--   * no claim-based admin policy (the custom access token hook is not enabled
--     on this project; see supabase/README.md). Admin surfaces read via the
--     service role until it is.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT CREATE
-- ---------------------------------------------------------------------------
-- Doc 25's canonical DDL carries five delivery columns - `channel`, `status`,
-- `sent_at`, `error`, `campaign_id` - and they are all omitted here, on
-- purpose, because every one of them describes machinery that does not exist:
--
--   * `channel` ('push','email','in_app') discriminates rows across delivery
--     channels. There are no VAPID keys, no push subscription, no service
--     worker registration for push, and no Resend credential anywhere in this
--     project, so every row this schema can ever hold today is an in_app row
--     and the column would be a constant. Doc 25's unread index is written
--     `where read_at is null and channel = 'in_app'`; with no channel column
--     that predicate is exactly `where read_at is null`, which is the index
--     created below and which stays correct verbatim once channel lands.
--   * `status` ('pending','sent','delivered','failed','read') is worker state
--     (doc 30 section 5.2 step 4: the FCM/Resend workers write it). With no
--     workers there is nothing to write it, and it would additionally FIGHT
--     the fence below: doc 30 section 5.6 has the recipient's mark-read set
--     `status='read'` as well as `read_at`, which would mean granting the
--     recipient UPDATE on a delivery-state column they could then set to
--     'failed'. Read state is `read_at is null`, one column, one meaning.
--   * `sent_at` / `error` are the same story: fields a send records, with no
--     send to record them.
--   * `campaign_id` (+ doc 25's notifications_campaign_idx) belongs to
--     marketing fan-out (F4, doc 32 "Send"), which is a later slice. A
--     nullable FK nothing can populate is not a schema, it is a placeholder.
--
-- All five arrive with the slice that can write them, together, in one
-- migration with the worker that owns them. `alter table ... add column` on a
-- nullable column with a default is a catalog-only operation in modern
-- Postgres, so nothing is being deferred at a cost.
--
-- ---------------------------------------------------------------------------
-- THE FENCE, AND WHY IT IS NOT AN APPEND-ONLY TRIGGER
-- ---------------------------------------------------------------------------
-- 0022's audit_logs is fenced three ways and the middle fence is a BEFORE
-- UPDATE OR DELETE trigger that raises unconditionally. That shape is WRONG
-- here and the reason is the whole design of this table: the recipient
-- legitimately updates their own row. Marking a notification read is a client
-- write to `read_at`, by the person the row is addressed to, and a blanket
-- immutability trigger would make the inbox's one interaction impossible.
--
-- What actually needs fencing is narrower than "no updates" and wider than
-- "own row": the recipient may move `read_at` and NOTHING ELSE. `title`,
-- `body`, `kind`, `data`, `business_id` and `user_id` are the message as the
-- server composed it, and a recipient who can rewrite them can rewrite the
-- record of what they were told - which matters most on exactly the rows worth
-- disputing (a rejection, an award amount).
--
-- Row-level RLS cannot express that. A policy chooses WHICH ROWS an update may
-- touch, never WHICH COLUMNS, so `notifications_owner_update` below would
-- happily let the recipient PATCH their own row's body. The mechanism that
-- does express it is the column-level UPDATE grant, which is exactly the fence
-- 0021 built for consumers.scan_blocked_until and profiles.is_suspended, and
-- for the same class of defect. Postgres note repeated from 0021 because it is
-- why the two statements are ordered the way they are: revoking a COLUMN
-- privilege is a no-op while a table-level UPDATE grant remains, so the
-- table-level privilege must go first and exactly the self-writable column be
-- granted back.
--
-- A trigger IS still used, in one narrow form (fence 3): it raises when an
-- UPDATE changes any column other than read_at, whoever the writer is. That is
-- not the blanket trigger 0022 uses; it is the same rule as the column grant,
-- restated at the layer that survives the grant being widened by mistake, and
-- it costs nothing today because `read_at` is the only column any writer in
-- this codebase updates.
--
-- DELETE is the other place this table differs from audit_logs, and it differs
-- in the opposite direction. An audit row may never be deleted by anyone. A
-- notification is an operational message with a documented retention policy
-- (doc 30 section 5.7 / doc 39's cleanup.notifications: in_app rows read more
-- than 90 days ago are deleted), so service_role KEEPS delete. Clients do not.
-- TRUNCATE goes for every role: no legitimate operation ever empties every
-- recipient's inbox in one statement.
-- ============================================================================

-- ============================================================ notifications
-- RLS: P2. The recipient selects their own rows and updates their own read_at.
-- No client insert of any kind: rows are raised by the service role from real
-- events, exactly like `receipts` (0017), `points_transactions` (0012) and
-- `audit_logs` (0022). A notification a consumer can write is a notification
-- that proves nothing, and "the store told me I was awarded 5,000 points" is
-- precisely the claim this table would otherwise manufacture evidence for.
create table public.notifications (
  id           uuid primary key default private.uuid_generate_v7(),
  -- The RECIPIENT. profiles, not consumers, per doc 25: business staff receive
  -- notifications too (staff_invite, verification_decision, campaign budget
  -- alerts), and profiles is the row every human has. ON DELETE CASCADE is
  -- doc 25's, and it is right here in a way it is deliberately not right on
  -- audit_logs: a message addressed to a person who no longer exists is
  -- undeliverable and unreadable by anyone, so it is noise, not evidence.
  user_id      uuid not null references public.profiles(id) on delete cascade,
  -- The SENDER tenant; null means the platform itself. Nullable and ON DELETE
  -- SET NULL per doc 25: a message already delivered stays readable after its
  -- sender is purged, it just stops being attributable. Every kind this slice
  -- raises carries one, because every one of them is about a receipt at a
  -- specific shop.
  business_id  uuid references public.businesses(id) on delete set null,

  -- amendment: doc 25 leaves `kind` as bare text with the registry noted in
  -- prose ("registry in src/features/notifications/kinds.ts ... adding a kind
  -- is code + doc, not schema"), and 0022 made the matching call for
  -- audit_logs.action by constraining the SHAPE and leaving the VOCABULARY to
  -- code. This file goes the other way and enumerates the values, because the
  -- argument 0022 made does not carry over.
  --
  -- 0022's reasoning was about WHERE the write sits: an audit row is the last
  -- statement of the transaction it records, so an unregistered verb raises
  -- 23514 and rolls back the receipt decision, the points award and the ledger
  -- row with it. A forgotten enum migration would take down the money path.
  --
  -- A notification write is the opposite by construction. It is FAIL-SOFT -
  -- src/features/notifications/server/raise.ts swallows every error and the
  -- points award stands regardless, which is pinned by its own test - so the
  -- worst an unlisted kind can do is cost one message. That inverts the trade:
  -- the value list is now cheap to enforce and worth enforcing, because `kind`
  -- is what the inbox switches its icon, its tone and its deep link on, and a
  -- typo'd kind renders as a blank, untappable row rather than failing loudly.
  --
  -- The five listed are the ones this codebase can actually raise or will
  -- raise next, per the task and docs 36/37/39:
  --   points_awarded    doc 36 Stage 10, on approval (auto or human)
  --   receipt_rejected  doc 36 Stage 10 + doc 37 ladder step 1, on rejection
  --   receipt_in_review doc 36 Stage 9, when a receipt is routed to a human.
  --                     NOT in doc 30 section 5.3's table: it is added by this
  --                     slice, which is exactly the "code + doc" path doc 25
  --                     describes, and the consumer has been waiting on a
  --                     silent receipt until now.
  --   reward_claimed    doc 30 section 5.3 [MVP], raised by the rewards slice
  --   reward_expiring   doc 30 section 5.3 [V1] / doc 33 (T-72h, T-24h)
  -- The remaining registry entries (staff_invite, campaign_push, announcement,
  -- ...) join this list in the migration of the slice that raises them.
  kind         text not null check (kind in (
                 'points_awarded',
                 'receipt_rejected',
                 'receipt_in_review',
                 'reward_claimed',
                 'reward_expiring'
               )),

  -- Rendered server-side from the kind's template (doc 30 section 5.2 step 2),
  -- stored rather than re-derived: a message says what it said when it was
  -- sent, and a copy edit six months from now must not silently rewrite a
  -- rejection a consumer is disputing.
  --
  -- The length caps are UI truth, not paranoia: the inbox renders the title on
  -- one line and clamps the body, so a 4KB body would be stored, shipped and
  -- never read. The blank checks exist because an empty string satisfies
  -- `not null` and renders as a notification that says nothing, which is worse
  -- than no notification at all.
  title        text not null check (btrim(title) <> '' and char_length(title) <= 120),
  body         text not null check (btrim(body) <> '' and char_length(body) <= 600),

  -- Deep link plus kind fields: `{route, params}` per doc 30 section 5.3.
  -- Doc 25's default, kept. jsonb rather than columns because the payload is
  -- per-kind by definition and every kind added later would otherwise be a
  -- migration.
  --
  -- WHAT MUST NOT GO IN HERE, stated where the column is defined because the
  -- column is granted to the recipient: `data` is read by the person the
  -- notification is addressed to. Nothing from the fraud stage, the parser's
  -- internals or another consumer's row may be written into it - no reject
  -- note, no signal, no score, no confidence, no matched receipt id. This is
  -- the same rule 0017 enforces with its column grant on receipts and doc 33
  -- states as "Never expose fraud signal internals"; here it is a writer
  -- discipline (see receipt-copy.ts and its test) because a jsonb column
  -- cannot enforce it.
  data         jsonb not null default '{}',

  -- Read state, and the ONLY column any client may write. Null = unread, which
  -- is what the partial index below counts and what the badge renders.
  read_at      timestamptz,
  created_at   timestamptz not null default now()
  -- NO updated_at / updated_by / deleted_at and no touch trigger. The only
  -- mutation this table has is read_at, which is its own timestamp; an
  -- updated_at beside it would say the same thing less precisely. Deletion is
  -- the retention job's hard delete (doc 30 section 5.7), not a soft flag.
);
alter table public.notifications enable row level security;

-- ---------------------------------------------------------------- indexes
-- Doc 25's two user indexes, one per real read pattern, plus the FK index doc
-- 20's conventions require ("Every FK indexed").

-- The recent list: /notifications renders the recipient's newest messages,
-- grouped by day (doc 30 section 5.6), cursor-paginated. (user_id, created_at
-- desc) serves the ORDER BY as well as the predicate, so the inbox is an index
-- scan with no sort. This is also the index the P2 policy is evaluated
-- against - user_id is its leading column - and it doubles as the FK index for
-- user_id.
create index notifications_user_idx on public.notifications (user_id, created_at desc);

-- The unread count: the badge, read on every consumer page load, and the one
-- query in this slice that runs whether or not anyone opens the inbox. Partial
-- because unread is the small set by construction (a read row never returns to
-- it), so the index stays roughly the size of one person's backlog rather than
-- their history.
--
-- Doc 25 writes this predicate as `where read_at is null and channel =
-- 'in_app'`. With no channel column (see the header) the second conjunct is
-- vacuously true for every row, so the predicate below is the same index; when
-- channel lands it is re-created with the conjunct restored and no query
-- changes.
create index notifications_user_unread_idx on public.notifications (user_id)
  where read_at is null;

-- business_id's FK index. Not a read pattern - nothing in this slice filters
-- an inbox by shop - but doc 20 requires every FK indexed, and the reason
-- shows up on the ON DELETE SET NULL path: without it, purging one business
-- sequentially scans every notification on the platform. Partial because the
-- null rows (platform messages) are exactly the ones that path never touches.
create index notifications_business_idx on public.notifications (business_id)
  where business_id is not null;

-- ---------------------------------------------------------------- policies
-- P2: the recipient reads their own inbox and nobody else's.
--
-- `(select auth.uid())` rather than a bare `auth.uid()`, matching every other
-- P2 policy in this schema (0002 profiles/consumers, 0017 receipts): the
-- scalar subquery is evaluated once per statement instead of once per row.
create policy notifications_owner_select on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()));

-- P2 write, and the ONLY client write on this table: mark read.
--
-- `using` pins which rows (own), `with check` pins what they may become (still
-- own), so a recipient cannot re-address a message to someone else even in the
-- one column they can write - and the column grant below means read_at is the
-- only column they can write at all. Both halves are needed: without the check
-- an UPDATE could move user_id if the grant were ever widened; without the
-- grant the policy alone would permit rewriting the body.
--
-- Un-reading (setting read_at back to null) is permitted and deliberate. It is
-- the recipient's own read state, doc 33 describes an inbox rather than a
-- ledger, and there is no invariant anywhere that a read message stays read.
create policy notifications_owner_update on public.notifications
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- NO insert policy and no insert privilege. See the table comment.
-- NO delete policy: the inbox has no delete affordance (doc 30 section 5.6 is
-- read/mark-read only) and retention is the cleanup job's, under the service
-- role.
-- NO staff policy. A merchant is a SENDER here, never an audience: business_id
-- names who the message is about, not who may read it, and every row this
-- slice writes is addressed to a consumer and carries the outcome of their
-- receipt. Doc 15's privacy line ("businesses see consumer data only for their
-- own customers and only what the CRM needs") does not stretch to reading that
-- consumer's inbox.
-- NO admin policy, for the reason 0017 and 0022 both give: the custom access
-- token hook is not enabled on this project, so a claim-based admin predicate
-- would evaluate null for every session and silently deny - coverage that
-- looks like coverage and is not.

-- ---------------------------------------------------------------- fence 1 of 3
-- Privilege layer, client roles. Supabase grants all privileges on new public
-- tables to the app roles by default, so with no policy AND no privilege a
-- client write fails loudly with 42501 instead of silently matching zero rows
-- (the 0013/0017/0022 pattern).
--
-- UPDATE is revoked here at the TABLE level and granted back per column below;
-- it has to be done in that order (see the header note carried from 0021).
revoke insert, update, delete, truncate on public.notifications from anon, authenticated;

-- anon has no policy and no business on this table: a personal inbox has no
-- anonymous audience. Revoked rather than left to RLS so a signed-out read
-- raises 42501 instead of returning an empty list that looks like "you have no
-- notifications".
revoke select on public.notifications from anon;

-- ---------------------------------------------------------------- fence 2 of 3
-- Column layer. THE fence of this file, and the one the header explains at
-- length: the recipient may move read_at and may not touch the message.
--
-- Everything withheld, and why it is dangerous:
--   * title, body   - the message as the server composed it. A recipient who
--                     can edit these can fabricate what a shop told them.
--   * kind          - drives the icon, the tone and the deep link, and is the
--                     value the check constraint above defends; client-writable
--                     kind would let a rejection re-render as an award.
--   * data          - the deep link payload, including the receipt id the
--                     inbox navigates to.
--   * user_id       - the recipient, i.e. the tenancy key of both policies
--                     above. Already pinned by the with check; withheld here
--                     as well so the two layers do not depend on each other.
--   * business_id   - who the message is attributed to.
--   * id, created_at - identity and ordering.
grant update (read_at) on public.notifications to authenticated;

-- Privilege layer, service_role. RLS does not apply to service_role at all and
-- never sees TRUNCATE from anyone, so this is the only fence for both.
--
-- INSERT stays: the service role is the WRITER (raise.ts).
-- UPDATE stays: reserved for the delivery slice's status writes, and harmless
--   today because fence 3 below pins every column but read_at regardless of
--   who the writer is.
-- DELETE stays, and this is the deliberate difference from 0022: doc 30
--   section 5.7 and doc 39's cleanup.notifications delete in_app rows read more
--   than 90 days ago. A notification is an operational message with a
--   retention policy, not a security record, so removing DELETE would break a
--   registered job rather than protect anything.
-- TRUNCATE goes. There is no operation, now or planned, that empties every
--   recipient's inbox in one statement, and the shape of the worst case here
--   is the same as 0022's: bulk, not per-row.
revoke truncate on public.notifications from service_role;

-- ---------------------------------------------------------------- fence 3 of 3
-- Row trigger, restating the column grant at the layer that survives it.
--
-- NOT 0022's blanket append-only trigger: this one permits the UPDATE the
-- inbox depends on and raises only when the update changes something else. The
-- header explains why the blanket form is wrong for this table; what this form
-- buys is the case the grant cannot cover - the table owner, the service role,
-- and any future `grant update on public.notifications to authenticated` typed
-- in a hurry.
--
-- `is distinct from` throughout, never `<>`: read_at, business_id and data are
-- nullable, and `null <> null` is null, which would let a null-to-value change
-- pass the guard silently.
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
     or new.title is distinct from old.title
     or new.body is distinct from old.body
     or new.data is distinct from old.data
     or new.created_at is distinct from old.created_at then
    raise exception
      'notifications is immutable except read_at (the message is what was sent)';
  end if;
  return new;
end
$$;

create trigger notifications_read_at_only
  before update on public.notifications
  for each row execute function private.notifications_read_at_only();

-- Statement trigger. A row-level trigger does not fire on TRUNCATE, and
-- nothing references notifications so no foreign key would refuse one first.
-- The revoke above already stops every role that exists; this catches a future
-- grant, exactly as 0022's does.
create or replace function private.notifications_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'notifications cannot be truncated (retention is per-row, doc 30 section 5.7)';
end
$$;

create trigger notifications_no_truncate
  before truncate on public.notifications
  for each statement execute function private.notifications_no_truncate();
