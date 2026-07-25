-- ============================================================================
-- 0000b_drop_legacy_profiles_flags_feedback.sql
-- HISTORICAL. Second half of the user-approved legacy cleanup, applied live as
-- version 20260724180338 "drop_legacy_profiles_flags_feedback" before 0001.
-- See 0000a and supabase/README.md "Migration ledger".
--
-- The legacy app's profiles table collided with Giya's own public.profiles
-- (0002), and its on_auth_user_created trigger was later replaced in 0003.
--
-- No-op on a fresh database: every statement is "if exists".
-- ============================================================================

drop table if exists public.feedback cascade;
drop table if exists public.feature_flags cascade;
drop table if exists public.profiles cascade;
