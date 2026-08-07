-- Migration: 0066_loyalty_cards.sql
-- Goal: Loyalty stamp card progression table and consumer RLS policies

create table if not exists public.loyalty_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete cascade,
  stamps_count integer not null default 0 check (stamps_count >= 0),
  stamps_target integer not null default 10 check (stamps_target > 0),
  prize_reward_name text not null default 'Free Prize',
  is_completed boolean not null default false,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ensure missing columns exist if table predated this migration
alter table public.loyalty_cards add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.loyalty_cards add column if not exists business_id uuid references public.businesses(id) on delete cascade;
alter table public.loyalty_cards add column if not exists stamps_count integer not null default 0;
alter table public.loyalty_cards add column if not exists stamps_target integer not null default 10;
alter table public.loyalty_cards add column if not exists prize_reward_name text not null default 'Free Prize';
alter table public.loyalty_cards add column if not exists is_completed boolean not null default false;
alter table public.loyalty_cards add column if not exists completed_at timestamptz;

-- Populate user_id from consumer_id if legacy consumer_id column exists
do $$
begin
  if exists (
    select 1 from information_schema.columns 
    where table_name = 'loyalty_cards' and column_name = 'consumer_id'
  ) then
    update public.loyalty_cards set user_id = consumer_id where user_id is null;
  end if;
end $$;

alter table public.loyalty_cards enable row level security;

-- Privilege hygiene
revoke all on public.loyalty_cards from public, anon, authenticated;
grant select on public.loyalty_cards to authenticated;
grant select, insert, update, delete on public.loyalty_cards to service_role;

-- RLS Policies
drop policy if exists loyalty_cards_consumer_select on public.loyalty_cards;
create policy loyalty_cards_consumer_select on public.loyalty_cards
  for select to authenticated
  using (user_id = auth.uid());
