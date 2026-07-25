-- ============================================================================
-- 0000a_drop_legacy_licenses_payments.sql
-- HISTORICAL. Recorded so the committed file set matches the live migration
-- ledger 1:1 (see supabase/README.md "Migration ledger").
--
-- The Supabase project Giya 2.0 was created on top of a project that already
-- held an unrelated application's tables. This was the first half of the
-- user-approved cleanup (2026-07-25), applied live as
-- version 20260724180330 "drop_legacy_licenses_payments" before 0001.
--
-- No-op on a fresh database: every statement is "if exists".
-- ============================================================================

drop table if exists public.licenses cascade;
drop table if exists public.payments cascade;
drop table if exists public.pricing cascade;
