-- Migration: 0065_favorites.sql
-- Goal: Consumer favorites table and RLS policies

create table if not exists public.favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint favorites_user_business_unique unique (user_id, business_id)
);

alter table public.favorites enable row level security;

-- Privilege hygiene
revoke all on public.favorites from public, anon, authenticated;
grant select, insert, delete on public.favorites to authenticated;
grant select, insert, update, delete on public.favorites to service_role;

-- RLS Policies for authenticated consumers
create policy favorites_consumer_select on public.favorites
  for select to authenticated
  using (user_id = auth.uid());

create policy favorites_consumer_insert on public.favorites
  for insert to authenticated
  with check (user_id = auth.uid());

create policy favorites_consumer_delete on public.favorites
  for delete to authenticated
  using (user_id = auth.uid());
