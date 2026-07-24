-- ============================================================================
-- 0003_auth_plumbing.sql
-- Signup trigger, business registration RPC, custom access token (JWT) hook.
-- Source docs: docs/10-architecture/12-multi-tenancy-rls.md (claims shape),
-- docs/20-data/21-schema-identity.md (target tables).
-- NOTE: the token hook must also be enabled manually in the dashboard, see
-- supabase/README.md.
-- ============================================================================

-- ---------------------------------------------------------------- handle_new_user
-- Creates profiles + consumers on signup. Security definer because it runs
-- from a trigger on auth.users (fired as supabase_auth_admin) and writes
-- RLS-protected public tables.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  i int;
begin
  v_name := nullif(trim(coalesce(new.raw_user_meta_data->>'full_name', '')), '');
  if v_name is null then
    v_name := nullif(split_part(coalesce(new.email, ''), '@', 1), '');
  end if;
  v_name := left(coalesce(v_name, 'Member'), 80);

  insert into public.profiles (id, display_name, created_by, updated_by)
  values (new.id, v_name, new.id, new.id)
  on conflict (id) do nothing;

  -- referral_code defaults to private.gen_referral_code(); retry a few times
  -- on the (vanishingly rare) unique collision
  for i in 1..5 loop
    begin
      insert into public.consumers (id, created_by, updated_by)
      values (new.id, new.id, new.id)
      on conflict (id) do nothing;
      exit;
    exception when unique_violation then
      -- referral_code collision: loop regenerates via the column default
      null;
    end;
  end loop;

  return new;
end
$$;

revoke execute on function private.handle_new_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------- register_business
-- Tenant lifecycle (doc 12): registering a business creates businesses (status
-- draft) + business_staff owner row atomically, one RPC.
create or replace function private.register_business(
  p_name text,
  p_type text,
  p_city text,
  p_address text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_type_id uuid;
  v_city_id uuid;
  v_slug    text;
  v_biz_id  uuid;
begin
  if v_uid is null then
    raise exception 'register_business requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_name is null or char_length(trim(p_name)) < 2 then
    raise exception 'business name must be at least 2 characters';
  end if;

  select id into v_type_id
    from public.ref_business_types
   where slug = p_type or lower(name) = lower(p_type)
   limit 1;
  if v_type_id is null then
    raise exception 'unknown business type: %', p_type;
  end if;

  if nullif(trim(coalesce(p_city, '')), '') is not null then
    select id into v_city_id
      from public.ref_cities
     where slug = p_city or lower(name) = lower(p_city)
     limit 1;
    if v_city_id is null then
      raise exception 'unknown city: %', p_city;
    end if;
  end if;

  -- slug: slugified name + short random suffix for uniqueness
  v_slug := trim(both '-' from regexp_replace(
              lower(private.immutable_unaccent(trim(p_name))), '[^a-z0-9]+', '-', 'g'));
  if char_length(v_slug) < 3 then
    v_slug := 'biz' || v_slug;
  end if;
  v_slug := left(v_slug, 50) || '-' || encode(extensions.gen_random_bytes(3), 'hex');

  insert into public.businesses
    (slug, name, status, business_type_id, address_line, city_id, created_by, updated_by)
  values
    (v_slug, trim(p_name), 'draft', v_type_id, nullif(trim(coalesce(p_address, '')), ''), v_city_id, v_uid, v_uid)
  returning id into v_biz_id;

  insert into public.business_staff
    (business_id, user_id, role, status, created_by, updated_by)
  values
    (v_biz_id, v_uid, 'owner', 'active', v_uid, v_uid);

  return v_biz_id;
end
$$;

revoke execute on function private.register_business(text, text, text, text) from public;

-- Thin public wrapper: the private schema is not exposed via PostgREST, so the
-- app calls supabase.rpc('register_business', ...) against this function.
create or replace function public.register_business(
  p_name text,
  p_type text,
  p_city text,
  p_address text
) returns uuid
language sql
security definer
set search_path = ''
as $$
  select private.register_business(p_name, p_type, p_city, p_address)
$$;

revoke execute on function public.register_business(text, text, text, text) from public, anon;
grant execute on function public.register_business(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------- custom access token hook
-- Stamps app_metadata claims at token issuance per doc 12: biz map from active
-- business_staff rows (capped at 20), biz_overflow flag, is_platform_admin and
-- admin_role from platform_admins (present only when true). Runs as
-- supabase_auth_admin (not security definer, the Supabase-documented pattern),
-- so that role gets schema usage, execute, table select, and RLS policies.
create or replace function private.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user_id    uuid  := (event->>'user_id')::uuid;
  v_claims     jsonb := coalesce(event->'claims', '{}'::jsonb);
  v_app_meta   jsonb := coalesce(v_claims->'app_metadata', '{}'::jsonb);
  v_biz        jsonb;
  v_count      int;
  v_admin_role text;
begin
  select count(*) into v_count
    from public.business_staff
   where user_id = v_user_id and status = 'active';

  if v_count > 0 then
    select jsonb_object_agg(s.business_id::text, s.role) into v_biz
      from (select business_id, role
              from public.business_staff
             where user_id = v_user_id and status = 'active'
             order by created_at
             limit 20) s;
    v_app_meta := v_app_meta || jsonb_build_object('biz', coalesce(v_biz, '{}'::jsonb));
    if v_count > 20 then
      v_app_meta := v_app_meta || jsonb_build_object('biz_overflow', true);
    end if;
  end if;

  select pa.role into v_admin_role
    from public.platform_admins pa
   where pa.user_id = v_user_id and pa.is_active = true;
  if v_admin_role is not null then
    v_app_meta := v_app_meta
      || jsonb_build_object('is_platform_admin', true, 'admin_role', v_admin_role);
  end if;

  v_claims := jsonb_set(v_claims, '{app_metadata}', v_app_meta);
  return jsonb_set(event, '{claims}', v_claims);
end
$$;

-- Grants: the auth server (supabase_auth_admin) is the only caller.
grant usage on schema private to supabase_auth_admin;
grant execute on function private.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function private.custom_access_token_hook(jsonb) from authenticated, anon, public;

grant select on table public.business_staff   to supabase_auth_admin;
grant select on table public.platform_admins  to supabase_auth_admin;

-- Hook plumbing policies (not P1-P4: internal auth-server read path).
-- supabase_auth_admin does not bypass RLS, so it needs explicit select policies.
create policy business_staff_auth_admin_select on public.business_staff
  for select to supabase_auth_admin using (true);
create policy platform_admins_auth_admin_select on public.platform_admins
  for select to supabase_auth_admin using (true);
