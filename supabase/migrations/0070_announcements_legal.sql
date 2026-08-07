-- Migration: 0070_announcements_legal.sql
-- Goal: Announcements & legal versioning tables and public policies

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  audience text not null default 'all' check (audience in ('all', 'consumers', 'businesses')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.legal_versions (
  id uuid primary key default gen_random_uuid(),
  doc_name text not null check (doc_name in ('terms', 'privacy')),
  version text not null,
  effective_date date not null,
  created_at timestamptz not null default now()
);

alter table public.announcements enable row level security;
alter table public.legal_versions enable row level security;

-- Privilege hygiene
revoke all on public.announcements from public, anon, authenticated;
grant select on public.announcements to anon, authenticated;
grant select, insert, update, delete on public.announcements to service_role;

drop policy if exists announcements_public_select on public.announcements;
create policy announcements_public_select on public.announcements
  for select to anon, authenticated
  using (is_active = true);

revoke all on public.legal_versions from public, anon, authenticated;
grant select on public.legal_versions to anon, authenticated;
grant select, insert, update, delete on public.legal_versions to service_role;

drop policy if exists legal_versions_public_select on public.legal_versions;
create policy legal_versions_public_select on public.legal_versions
  for select to anon, authenticated
  using (true);
