-- ============================================================================
-- 0063_find_auth_user_by_email.sql
-- public.find_auth_user_by_email(text): the staff-invite module's read of
-- `auth.users`, replacing a `.schema("auth")` PostgREST call that review
-- found unreliable.
--
-- WHY THIS EXISTS (review, round 3-4). `src/features/businesses/staff/
-- server/service.ts`'s `findExistingAuthUser` originally called
-- `supabase.schema("auth").from("users")...` directly. That takes the
-- PostgREST cross-schema path (`Accept-Profile: auth`), which PostgREST only
-- serves for schemas listed in its `db-schemas` config - defaulting to
-- `public, graphql_public`, with the actual live setting stored in the
-- PostgREST SERVICE configuration, not anywhere the database itself can
-- report (`current_setting('pgrst.db_schemas')` reads null on this
-- project). So whether that call worked was genuinely unverifiable from
-- inside a migration or a SQL session, and its silent failure mode
-- (PGRST106, logged, treated as "not found") would make the whole review-
-- round-3 fix for inviting an EXISTING Giya user invisibly degrade back to
-- always minting a new account - safe, but wrong, and undetectable without
-- a live PostgREST probe.
--
-- A `public`-schema SECURITY DEFINER function sidesteps the whole question:
-- it is reached through the ORDINARY `public` PostgREST path every other
-- RPC in this schema already uses (verifiable the same way as any of them),
-- and it reads `auth.users` from INSIDE Postgres, where cross-schema access
-- is a plain privilege check the function owner already has - no PostgREST
-- schema-exposure setting involved at all.
--
-- COLUMNS, DELIBERATELY NARROW. Returns `(id, email)` only - never
-- `select *` on `auth.users`, which carries `encrypted_password`,
-- confirmation tokens, and every other authentication secret this caller
-- (an invite-issuing merchant's request) has no business touching. The
-- caller (service.ts) only ever reads `.id` off the result; `email` is
-- returned for the same reason `award_receipt_points` and its siblings
-- return more than one column when a caller needs only one - so a future
-- caller with a genuine reason to log or compare the matched address does
-- not have to widen this function to get it.
--
-- NORMALIZATION LIVES HERE, not in the caller. `lower(btrim(...))` on BOTH
-- sides: the input (a merchant-typed address, already trimmed/lowercased by
-- `src/features/businesses/staff/schemas.ts`'s `inviteSchema` before it ever
-- reaches here, but this function must not assume every future caller does
-- that) and the stored value (GoTrue normalizes new signups to lowercase,
-- but this project has 62 prior migrations' worth of history and nothing
-- guarantees every historical row was written that way). One normalization
-- rule, in the one place that owns the comparison, rather than trusting it
-- to agree with a caller-side rule forever.
--
-- GRANTS (review: "mandatory, asserted independently" -
-- supabase/tests/rpc_find_auth_user_by_email_smoke.sql):
--   anon            denied  (revoked below)
--   authenticated   denied  (revoked below)
--   service_role    allowed (Supabase's default privileges grant EXECUTE on
--                    every new public-schema function to service_role at
--                    CREATE time, per 0052's documented finding - the
--                    explicit grant below is not what makes this true, it
--                    is this migration saying out loud that it is intended,
--                    matching 0033's `submit_business_for_review` and
--                    siblings' own convention of stating the grant it
--                    relies on rather than leaving it implicit)
-- No RLS clause needed: this is a function grant, not a table policy -
-- `auth.users` itself is a Supabase-managed table this migration does not
-- touch.
-- ============================================================================

create or replace function public.find_auth_user_by_email(p_email text)
returns table (id uuid, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.email
    from auth.users u
   where lower(u.email) = lower(btrim(p_email))
   limit 1
$$;

revoke execute on function public.find_auth_user_by_email(text)
  from public, anon, authenticated;
grant execute on function public.find_auth_user_by_email(text)
  to service_role;
