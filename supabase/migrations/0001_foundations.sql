-- ============================================================================
-- 0001_foundations.sql
-- Extensions, private schema, UUIDv7 generator, shared triggers, claim helpers.
-- Source docs: docs/20-data/20-data-model.md, docs/10-architecture/12-multi-tenancy-rls.md
-- ============================================================================

-- ---------------------------------------------------------------- extensions
-- Hosted Supabase installs extensions into the `extensions` schema.
-- amendment: doc 20 names pg_uuidv7; the extension is not available on hosted
-- Supabase, so private.uuid_generate_v7() below implements UUIDv7 in SQL.
create extension if not exists pgcrypto  with schema extensions;
create extension if not exists vector    with schema extensions;
create extension if not exists pg_trgm   with schema extensions;
create extension if not exists unaccent  with schema extensions;
create extension if not exists pgtap     with schema extensions;

-- ---------------------------------------------------------------- private schema
-- Not exposed via PostgREST (only public is in the exposed schema list).
create schema if not exists private;

-- Lock the schema down, then grant narrowly below.
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------- uuid v7
-- Standard UUIDv7: unix-ms timestamp in the top 48 bits, version nibble 7,
-- RFC 4122 variant bits, 74 random bits from pgcrypto.
create or replace function private.uuid_generate_v7()
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  unix_ms bigint;
  buf bytea;
begin
  unix_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  buf := extensions.gen_random_bytes(10);
  -- byte 0 of buf becomes UUID byte 6: high nibble = version 7
  buf := set_byte(buf, 0, (get_byte(buf, 0) & 15) | 112);
  -- byte 2 of buf becomes UUID byte 8: top two bits = variant 10
  buf := set_byte(buf, 2, (get_byte(buf, 2) & 63) | 128);
  return encode(substring(int8send(unix_ms) from 3 for 6) || buf, 'hex')::uuid;
end
$$;

-- Column defaults evaluate with invoker privileges, so app roles need execute.
grant execute on function private.uuid_generate_v7() to authenticated, anon, service_role;

-- ---------------------------------------------------------------- updated_at touch
-- Shared trigger per doc 20. Trigger firing does not require execute privilege
-- from the DML role, so no broad grants are needed.
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

-- ---------------------------------------------------------------- immutable unaccent
-- amendment: unaccent(text) is only STABLE, which Postgres rejects inside
-- generated-column expressions (businesses.search_tsv). This immutable wrapper
-- pins the dictionary explicitly, which is the documented-safe workaround.
create or replace function private.immutable_unaccent(p_text text)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select extensions.unaccent('extensions.unaccent'::regdictionary, p_text)
$$;

grant execute on function private.immutable_unaccent(text) to authenticated, anon, service_role;

-- ---------------------------------------------------------------- claim helpers
-- Transcribed from docs/10-architecture/12-multi-tenancy-rls.md section
-- "Claim helper functions (SQL)". Kept stable so the planner can inline them.
create or replace function private.jwt_biz_role(bid uuid)
returns text language sql stable as $$
  select coalesce(
    (auth.jwt()->'app_metadata'->'biz'->>bid::text),
    case when (auth.jwt()->'app_metadata'->>'biz_overflow')::boolean is true then
      (select role from public.business_staff
        where business_id = bid and user_id = auth.uid() and status = 'active')
    end
  )
$$;

create or replace function private.is_staff_of(bid uuid, min_roles text[])
returns boolean language sql stable as $$
  select private.jwt_biz_role(bid) = any(min_roles)
$$;

create or replace function private.is_admin()
returns boolean language sql stable as $$
  select coalesce((auth.jwt()->'app_metadata'->>'is_platform_admin')::boolean, false)
$$;

-- RLS policies run these as the invoking role; authenticated must be able to
-- execute them. Policies that apply to anon never reference these helpers
-- (they are scoped with `to authenticated`), so anon gets no grant.
revoke execute on function private.jwt_biz_role(uuid)          from public;
revoke execute on function private.is_staff_of(uuid, text[])   from public;
revoke execute on function private.is_admin()                  from public;
grant execute on function private.jwt_biz_role(uuid)         to authenticated, service_role;
grant execute on function private.is_staff_of(uuid, text[])  to authenticated, service_role;
grant execute on function private.is_admin()                 to authenticated, service_role;
