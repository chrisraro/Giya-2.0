-- ============================================================================
-- 0020_realtime_receipts.sql
-- Enable Supabase Realtime on `receipts` so the consumer's /scan/[receiptId]
-- status screen and the wallet's pending receipt entry flip the moment the
-- pipeline decides an outcome. This is the FIRST of the three sanctioned
-- Realtime uses in doc 10 decision D5 ("receipt status, redemption
-- confirmation, admin queue counters"); 0014 added the second one
-- (reward_claims) and this file follows its pattern exactly.
--
-- Why this migration exists at all: `receipts` was NOT in the
-- supabase_realtime publication (verified live against dcnpuvtbftpbcjcvfnlt -
-- the publication contained reward_claims and nothing else). Without it,
-- postgres_changes on `receipts` subscribes and reports SUBSCRIBED but no
-- event ever arrives, so the status screen would have silently degraded to
-- its 5s poll fallback forever, with no error anywhere to explain why.
--
-- RLS: Realtime respects it. A consumer receives changes only to rows matching
-- receipts_consumer_select (user_id = auth.uid()); staff only to rows matching
-- receipts_staff_select (owner/manager of the matched business). No new
-- exposure beyond what a SELECT already returns.
--
-- COLUMN-LEVEL GRANT INTERACTION - the reason `replica identity full` is still
-- correct here despite 0017's narrowed grant:
--
--   0017 revoked the table-level SELECT on `receipts` from authenticated and
--   re-granted only 13 columns, deliberately withholding reject_note,
--   parse_meta, match_confidence, parse_confidence, sha256 and image_hash.
--   Realtime's WALRUS layer applies column-level privileges as well as row
--   policies: any column the subscribing role cannot SELECT is stripped from
--   both `record` and `old_record` before the payload is sent. So FULL
--   replica identity widens what Postgres puts in the WAL, not what a
--   consumer receives - the consumer still sees exactly the 13 granted
--   columns, which is precisely the set the status screen and the wallet
--   history render.
--
--   FULL (rather than the DEFAULT primary-key-only identity) is what makes
--   `old_record` carry the previous status on an UPDATE, and what keeps the
--   `id=eq.{receipt_id}` / `user_id=eq.{uid}` subscription filters evaluable
--   against the old tuple as well as the new one. It matches 0014 so both
--   Realtime tables behave identically for client code.
--
-- No DDL on the table itself, no policy change, no grant change: this file
-- only changes replication metadata.
-- ============================================================================

alter table public.receipts replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'receipts'
  ) then
    alter publication supabase_realtime add table public.receipts;
  end if;
end
$$;
