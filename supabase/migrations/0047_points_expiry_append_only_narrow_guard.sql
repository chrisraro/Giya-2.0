-- ============================================================================
-- 0047_points_expiry_append_only_narrow_guard.sql
-- Review fix (task 1.3, re-review N1): restores the true migration history
-- around 0042's backfill, which the previous fix pass got wrong.
--
-- WHAT ACTUALLY HAPPENED, IN ORDER:
--   1. 0042 ran on 2026-08-06 exactly as its file still reads: it disabled
--      `points_transactions_append_only` for one `UPDATE` statement (the
--      12-month backfill of pre-existing earn rows), then re-enabled it in
--      the same migration. That is real history and 0042 is restored to it
--      verbatim - it must not be rewritten to describe a fence that was
--      narrowed before it ever ran, because it was not.
--   2. The first review-fix pass (commit 78a5d95) replaced 0042's disable/
--      re-enable with a permanent narrow-guard trigger function - correctly
--      identifying that the unconditional trigger, needing a disable/enable
--      dance around every future backfill, was the wrong shape long-term -
--      but applied that replacement BY EDITING 0042 IN PLACE and reapplying
--      it live out of band, rather than through a new migration file. That
--      was the actual mistake: `supabase db push` (and this repo's whole
--      "plain SQL files, applied top to bottom" model, README.md "How
--      migrations are applied") compares recorded VERSION/NAME, not file
--      content. A database that already ran old-0042 would never receive
--      the rewritten body, because nothing tells it to - the migration
--      ledger would show 0042 as done and move on. The live project here
--      happened to get the new body only because it was pushed by hand with
--      `execute_sql`, which leaves no ledger trace at all.
--
-- THIS MIGRATION is the correctly-shaped fix: it installs the permanent
-- narrow guard as its OWN, own-numbered change, so every environment that
-- replays the file set in order - a fresh database, or one that already ran
-- the original 0042 - ends up with the identical trigger function, and the
-- ledger honestly records when and how it changed. Exactly the `0011b`
-- precedent this repo already uses for the same shape of problem (README.md:
-- "0011b is deliberately a no-op file: the policy conversion it applied live
-- is contained in the amended 0011 for fresh replays. It exists only to keep
-- the file set and the ledger aligned").
--
-- LIVE STATUS, STATED PLAINLY: this migration is a NO-OP on the project this
-- task has been developed against (`zlfxfzlnklqhajacngxf`). The out-of-band
-- push already installed this exact function body, so `create or replace`
-- here changes nothing live - it only gives the change a migration number and
-- a place in the file set, which is the entire point: the NEXT environment to
-- replay this file set from scratch (old-0042 disables/backfills/re-enables
-- under the unconditional trigger, THEN this file installs the permanent
-- guard) reaches the identical end state with real history intact, instead of
-- silently diverging from a project that only ever saw the out-of-band push.
--
-- WHY THE GUARD IS SAFE TO INSTALL AFTER THE FACT (unlike the previous pass's
-- claim that it had to precede the backfill): the backfill statement itself
-- is a one-time, already-executed fact on every real environment by the time
-- this file runs. On a FRESH replay, old-0042's own disable/enable already
-- makes that statement legal under the OLD trigger, so this migration does
-- not need to run first or precede anything - it only has to run at all, at
-- some point after 0042, to leave the schema in its final, permanent shape.
-- The previous pass's "must precede the backfill" reasoning was an aesthetic
-- preference about a statement that is already a no-op by the time any new
-- environment reaches it, not a genuine ordering constraint - see the
-- re-review finding for this correction, stated plainly rather than
-- defended.
--
-- WHAT THE GUARD DOES (unchanged from the previous pass; only its home
-- migration has moved). `private.points_transactions_append_only` continues
-- to refuse every UPDATE and DELETE unconditionally, with exactly ONE
-- permanent exception: `expires_at` moving from null to a non-null value with
-- nothing else on the row changing. This is the SAME shape 0026/0030's
-- `notifications_read_at_only` already established for the identical class of
-- problem (a table that must stay immutable except for one specific,
-- legitimate, recurring transition) - not a disable/enable pair a future
-- author could point to as precedent for taking the fence down for their own,
-- different write.
--
-- Source docs: docs/30-modules/35-points-engine.md section 7; 0012's
-- append-only fence and its three-layer design; 0026/0030's
-- notifications_read_at_only (the narrow-guard precedent this mirrors);
-- supabase/README.md's 0011b note (the "companion file, not a rewrite"
-- convention this migration follows).
-- ============================================================================

create or replace function private.points_transactions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'points_transactions is append-only';
  end if;

  -- TG_OP = 'UPDATE'. `is distinct from` throughout (not `<>`), matching
  -- 0026/0030's own idiom: several of these columns are nullable and
  -- `null <> null` is null, which would let a null-to-null "no-op" slip past
  -- a `<>` guard undetected on the columns that must not move at all.
  --
  -- N7 (re-review): this enumerates every column points_transactions has as
  -- of 0012 BY NAME, deliberately - a column added later that is left out of
  -- this list would become silently mutable during an expires_at stamp.
  -- `rpc_points_expiry_smoke.sql` now pins the full, exact column set the
  -- same way `rls_consumer_fence_smoke.sql` pins 0021's self-update
  -- allowlists, so adding a column to points_transactions without deciding
  -- whether this guard must also name it fails that suite rather than
  -- passing quietly.
  if old.id            is distinct from new.id
     or old.business_id  is distinct from new.business_id
     or old.consumer_id  is distinct from new.consumer_id
     or old.type         is distinct from new.type
     or old.points       is distinct from new.points
     or old.balance_after is distinct from new.balance_after
     or old.receipt_id   is distinct from new.receipt_id
     or old.claim_id     is distinct from new.claim_id
     or old.campaign_id  is distinct from new.campaign_id
     or old.rule_snapshot is distinct from new.rule_snapshot
     or old.reverses_id  is distinct from new.reverses_id
     or old.adjust_reason is distinct from new.adjust_reason
     or old.actor_id     is distinct from new.actor_id
     or old.created_at   is distinct from new.created_at
     or old.created_by   is distinct from new.created_by
     -- The one permitted transition: expires_at null -> non-null. Both halves
     -- are required: `old.expires_at is not null` catches an attempt to
     -- CHANGE an already-stamped value; `new.expires_at is null` catches an
     -- attempt to CLEAR one back out.
     or old.expires_at is not null
     or new.expires_at is null then
    raise exception
      'points_transactions is append-only (the one exception: stamping expires_at from null to a value, nothing else)';
  end if;

  return new;
end
$$;
