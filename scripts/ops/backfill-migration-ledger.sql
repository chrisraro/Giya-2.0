-- ============================================================================
-- scripts/ops/backfill-migration-ledger.sql  (OPERATOR SCRIPT - NOT a migration)
--
-- Records in supabase_migrations.schema_migrations the migrations that ARE
-- applied on production (zlfxfzlnklqhajacngxf) but were applied outside the
-- Supabase MCP / CLI (SQL Editor or execute_sql), so the ledger never got a row.
-- Verified 2026-10-03 against the live ledger: 0065-0077, 0080, 0081 and 0082
-- had no row. (0064 and 0079 are already recorded, under the unprefixed names
-- `avatars_storage` and `business_documents_storage`; 0078 is recorded.)
--
-- WHAT IT DOES: inserts ledger ROWS only. It runs no schema SQL, changes no
-- table, function or data outside the ledger, and is idempotent - each insert
-- is skipped when a row with that name already exists, so running it twice is
-- harmless.
--
-- `version` values are synthetic (20261003 + the file number) because these
-- were never applied with a CLI timestamp; they sort after every real entry.
-- `statements` holds a pointer to the file rather than the SQL itself: the
-- ledger here is the record of WHAT was applied, and the repo is the source.
--
-- 0075 and 0077 were data resets that DID run (later neutralised in the repo
-- to comment-only no-ops); they are recorded so the ledger matches history.
--
-- Run once in the Supabase SQL Editor.
-- ============================================================================

insert into supabase_migrations.schema_migrations (version, name, statements)
select v.version, v.name, array['-- backfilled 2026-10-03; applied outside the CLI. Source: supabase/migrations/' || v.name || '.sql']
  from (values
    ('20261003000065', '0065_favorites'),
    ('20261003000066', '0066_loyalty_cards'),
    ('20261003000067', '0067_business_documents'),
    ('20261003000068', '0068_analytics_rollup'),
    ('20261003000069', '0069_qr_codes'),
    ('20261003000070', '0070_announcements_legal'),
    ('20261003000071', '0071_settings'),
    ('20261003000072', '0072_partitioning_helpers'),
    ('20261003000073', '0073_enterprise_sso'),
    ('20261003000074', '0074_seed_admin'),
    ('20261003000075', '0075_clear_business_data'),
    ('20261003000076', '0076_purge_business_rpc'),
    ('20261003000077', '0077_force_delete_business'),
    ('20261003000080', '0080_lock_purge_rpcs_and_settings'),
    ('20261003000081', '0081_purge_rpcs_super_admin_only'),
    ('20261003000082', '0082_validate_redemption_server_only')
  ) as v(version, name)
 where not exists (
   select 1 from supabase_migrations.schema_migrations m where m.name = v.name
 );

-- Check: should list all 16 names above.
select version, name
  from supabase_migrations.schema_migrations
 where name ~ '^00(6[5-9]|7[0-7]|8[0-2])_'
 order by version;
