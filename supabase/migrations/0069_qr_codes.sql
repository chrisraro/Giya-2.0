-- Migration: 0069_qr_codes.sql
-- Goal: Universal QR code registry and public lookup policies

create table if not exists public.qr_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  business_id uuid not null references public.businesses(id) on delete cascade,
  target_type text not null check (target_type in ('business_page', 'campaign', 'reward')),
  target_id uuid,
  scan_count integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.qr_codes enable row level security;

-- Privilege hygiene
revoke all on public.qr_codes from public, anon, authenticated;
grant select on public.qr_codes to anon, authenticated;
grant select, insert, update, delete on public.qr_codes to service_role;

-- Public lookup policy
drop policy if exists qr_codes_public_select on public.qr_codes;
create policy qr_codes_public_select on public.qr_codes
  for select to anon, authenticated
  using (true);
