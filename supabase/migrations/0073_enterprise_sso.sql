-- Migration: 0073_enterprise_sso.sql
-- Goal: Enterprise SSO / SAML 2.0 provider bindings and RLS policies

create table if not exists public.enterprise_sso_configs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  domain text not null unique,
  provider text not null check (provider in ('okta', 'azure_ad', 'ping_identity', 'custom_saml')),
  metadata_url text,
  entity_id text not null,
  sso_url text not null,
  certificate_fingerprint text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.enterprise_sso_configs enable row level security;

-- Privilege hygiene
revoke all on public.enterprise_sso_configs from public, anon, authenticated;
grant select on public.enterprise_sso_configs to authenticated;
grant select, insert, update, delete on public.enterprise_sso_configs to service_role;

-- RLS Policy: staff owner/manager can view
drop policy if exists sso_configs_staff_select on public.enterprise_sso_configs;
create policy sso_configs_staff_select on public.enterprise_sso_configs
  for select to authenticated
  using (
    private.is_staff_of(business_id, array['owner', 'manager'])
  );
