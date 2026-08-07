-- Migration: 0067_business_documents.sql
-- Goal: Business compliance document persistence and staff RLS policies

create table if not exists public.business_documents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  doc_type text not null check (doc_type in ('dti_permit', 'mayor_permit', 'bir_2303', 'other')),
  file_path text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'revision_requested', 'rejected')),
  revision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.business_documents enable row level security;

-- Privilege hygiene
revoke all on public.business_documents from public, anon, authenticated;
grant select, insert, update on public.business_documents to authenticated;
grant select, insert, update, delete on public.business_documents to service_role;

-- RLS Policies for active staff
drop policy if exists business_docs_staff_select on public.business_documents;
create policy business_docs_staff_select on public.business_documents
  for select to authenticated
  using (
    private.is_staff_of(business_id, array['owner', 'manager', 'marketing', 'staff'])
  );

drop policy if exists business_docs_staff_insert on public.business_documents;
create policy business_docs_staff_insert on public.business_documents
  for insert to authenticated
  with check (
    private.is_staff_of(business_id, array['owner', 'manager'])
  );
