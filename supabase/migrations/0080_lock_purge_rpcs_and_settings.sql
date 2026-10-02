-- ============================================================================
-- 0080_lock_purge_rpcs_and_settings.sql
-- SECURITY: two live exposures found by the 2026-10-03 full audit (Supabase
-- security advisor + DB review), both confirmed against the live database.
--
-- 1. THE PURGE FUNCTIONS WERE CALLABLE BY ANYONE.
--      public.force_delete_business(uuid)          - no caller check at all
--      public.purge_business(uuid, uuid, text)      - checks only that the
--      public.purge_all_businesses(uuid, text)      -   reason is non-blank
--    All three are SECURITY DEFINER and disable the append-only/immutability
--    triggers on points_transactions, receipts, ocr_results, fraud_signals,
--    audit_logs and notifications before deleting. 0076/0077 granted EXECUTE
--    to service_role but never revoked Supabase's default PUBLIC grant, so
--    `anon` and `authenticated` could call them: with only the public anon
--    key, `POST /rest/v1/rpc/purge_all_businesses` would erase every business,
--    the points ledger and the audit trail. `p_actor_id` is caller-supplied and
--    never checked. The only legitimate caller,
--    src/features/admin/business-decisions.ts, uses the service-role client,
--    so this revoke changes no app behaviour.
--
-- 2. THE PLATFORM SETTINGS WERE PUBLIC.
--    0071 ran `create table if not exists public.settings` against the table
--    0017 had already created (a no-op), then unconditionally added
--    `settings_public_select ... to anon, authenticated using (true)` plus an
--    anon SELECT grant. 0017 deliberately gave platform rows no client policy.
--    Live: 19 platform rows, 16 of them fraud/OCR/AI thresholds, readable by
--    anyone - doc 37 says fraud internals are never exposed. Both readers
--    (src/lib/ai/budget.ts, src/features/receipts/server/settings.ts) use the
--    service-role client; admins and staff keep 0017's scoped policies.
--
-- Follow-ups (separate changes): in-body platform_admins checks in the purge
-- functions so a future grant mistake cannot reopen them; pgTAP suites pinning
-- these grants and settings visibility; neutralise the destructive data-reset
-- statements in 0075/0077 so a replay cannot wipe an environment.
-- ============================================================================

-- ------------------------------------------------------------- 1: purge RPCs
revoke execute on function public.force_delete_business(uuid)
  from public, anon, authenticated;
grant execute on function public.force_delete_business(uuid)
  to service_role;

revoke execute on function public.purge_business(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.purge_business(uuid, uuid, text)
  to service_role;

revoke execute on function public.purge_all_businesses(uuid, text)
  from public, anon, authenticated;
grant execute on function public.purge_all_businesses(uuid, text)
  to service_role;

-- ------------------------------------------------------------- 2: settings
drop policy if exists settings_public_select on public.settings;
revoke select on public.settings from anon;
