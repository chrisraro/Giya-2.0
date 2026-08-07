-- Migration: 0072_partitioning_helpers.sql
-- Goal: Table partitioning procedures & multi-branch hierarchy table

create table if not exists public.business_branches (
  id uuid primary key default gen_random_uuid(),
  parent_business_id uuid not null references public.businesses(id) on delete cascade,
  branch_business_id uuid not null references public.businesses(id) on delete cascade,
  branch_code text,
  created_at timestamptz not null default now(),
  constraint business_branches_unique unique (parent_business_id, branch_business_id)
);

alter table public.business_branches enable row level security;

-- Privilege hygiene
revoke all on public.business_branches from public, anon, authenticated;
grant select on public.business_branches to authenticated;
grant select, insert, update, delete on public.business_branches to service_role;

-- RLS Policy: staff of parent or branch can view
drop policy if exists business_branches_staff_select on public.business_branches;
create policy business_branches_staff_select on public.business_branches
  for select to authenticated
  using (
    private.is_staff_of(parent_business_id, array['owner', 'manager'])
    or private.is_staff_of(branch_business_id, array['owner', 'manager', 'marketing', 'staff'])
  );

-- Partitioning helper procedure for historical log tables
create or replace function private.create_monthly_partition(
  table_name text,
  year_num integer,
  month_num integer
)
returns void
language plpgsql
security definer
as $$
declare
  partition_name text;
  start_date text;
  end_date text;
begin
  partition_name := table_name || '_' || year_num || '_' || lpad(month_num::text, 2, '0');
  start_date := year_num || '-' || lpad(month_num::text, 2, '0') || '-01';
  
  if month_num = 12 then
    end_date := (year_num + 1) || '-01-01';
  else
    end_date := year_num || '-' || lpad((month_num + 1)::text, 2, '0') || '-01';
  end if;

  execute format(
    'create table if not exists %I partition of %I for values from (%L) to (%L)',
    partition_name, table_name, start_date, end_date
  );
end;
$$;
