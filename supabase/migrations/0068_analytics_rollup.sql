-- Migration: 0068_analytics_rollup.sql
-- Goal: Analytics daily business rollup table and staff RLS policies

create table if not exists public.analytics_daily_business (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  date date not null,
  total_receipts_count integer not null default 0,
  approved_receipts_count integer not null default 0,
  total_gmv_centavos bigint not null default 0,
  points_awarded bigint not null default 0,
  points_redeemed bigint not null default 0,
  created_at timestamptz not null default now(),
  constraint analytics_daily_business_unique unique (business_id, date)
);

alter table public.analytics_daily_business enable row level security;

-- Privilege hygiene
revoke all on public.analytics_daily_business from public, anon, authenticated;
grant select on public.analytics_daily_business to authenticated;
grant select, insert, update, delete on public.analytics_daily_business to service_role;

-- RLS Policies for active staff
drop policy if exists analytics_daily_staff_select on public.analytics_daily_business;
create policy analytics_daily_staff_select on public.analytics_daily_business
  for select to authenticated
  using (
    private.is_staff_of(business_id, array['owner', 'manager', 'marketing', 'staff'])
  );
