-- Migration: 0071_settings.sql
-- Goal: System settings table for maintenance mode & global flags

create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.settings enable row level security;

-- Privilege hygiene
revoke all on public.settings from public, anon, authenticated;
grant select on public.settings to anon, authenticated;
grant select, insert, update, delete on public.settings to service_role;

-- Public read policy
drop policy if exists settings_public_select on public.settings;
create policy settings_public_select on public.settings
  for select to anon, authenticated
  using (true);
