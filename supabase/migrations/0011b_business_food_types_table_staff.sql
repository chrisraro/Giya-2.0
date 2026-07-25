-- ============================================================================
-- 0011b_business_food_types_table_staff.sql
-- HISTORICAL, INTENTIONALLY A NO-OP ON FRESH REPLAY.
--
-- Applied live as version 20260725025010 to convert the two
-- business_food_types staff policies from the claim-based private.is_staff_of
-- to the table-truth private.is_active_staff, immediately after 0011. The
-- 0011 FILE was then amended to include those same policy definitions, so a
-- fresh replay of 0001..0016 already creates them correctly and re-running
-- the conversion here would fail with "policy already exists".
--
-- This file exists so the committed migration set maps 1:1 onto the live
-- ledger (see supabase/README.md "Migration ledger"). It deliberately does
-- nothing.
-- ============================================================================

do $$
begin
  -- no-op: the policy conversion this version applied live is contained in
  -- 0011_identity_table_staff_policies.sql for fresh replays.
  null;
end
$$;
