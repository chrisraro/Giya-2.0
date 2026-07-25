-- ============================================================================
-- 0014_realtime_reward_claims.sql
-- Enable Supabase Realtime on reward_claims so the consumer's redemption QR
-- screen flips to a success state the moment staff validates it. This is one
-- of the three sanctioned Realtime uses in doc 10 decision D5 (receipt status,
-- redemption confirmation, admin queue counters).
--
-- Realtime respects RLS, so a consumer only receives changes to their own
-- claim rows (reward_claims_consumer_select) and staff only to their tenant's
-- (reward_claims_staff_select). No new exposure.
--
-- replica identity full is required for the payload to carry the changed row's
-- columns for UPDATEs (the QR screen reads status/redeemed_at).
-- ============================================================================

alter table public.reward_claims replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'reward_claims'
  ) then
    alter publication supabase_realtime add table public.reward_claims;
  end if;
end
$$;
