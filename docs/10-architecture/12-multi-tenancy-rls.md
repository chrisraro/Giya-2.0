# 12 — Multi-Tenancy & Row Level Security Design

The tenant isolation model for 100,000+ businesses on shared infrastructure. This document is **Locked**: changes require an ADR.

## Tenancy model

**Shared database, shared schema, row-level isolation.** Every tenant-scoped table carries a `business_id uuid not null` column — even when it is derivable through a join. This denormalization is deliberate and non-negotiable:

1. RLS policies stay single-table (no subquery-per-row on the hot path).
2. Future partitioning by `business_id`-containing composite keys is mechanical.
3. Every index on tenant data leads with or includes `business_id`.

Consumer-owned data (their profile, favorites, device tokens) is scoped by `user_id` instead. Rows that join a consumer to a business (`business_customers`, `points_transactions`, `receipts`) carry **both** and have policies for both audiences.

### Why not schema-per-tenant or DB-per-tenant
100k tenants × schema = migration and connection-pool catastrophe. Giya tenants are small and numerous (SMEs), the classic shared-schema case. Isolation is enforced by RLS + composite indexes; noisy-neighbor risk is handled by rate limits and queue fairness, not physical separation.

## Identity → roles → claims

### Tables (defined fully in `20-data/21-schema-identity.md`)

- `profiles` — 1:1 with `auth.users`; platform-wide profile.
- `platform_admins` — `user_id`, `role in ('super_admin','admin','support')`.
- `business_staff` — `business_id`, `user_id`, `role in ('owner','manager','marketing','staff')`, `status`.
- `consumers` — 1:1 consumer extension of profile.

### JWT custom claims

A Supabase **Custom Access Token Hook** (Postgres function, `security definer`) stamps claims at token issuance:

```jsonc
{
  "sub": "…user uuid…",
  "app_metadata": {
    "is_platform_admin": true,          // present only when true
    "admin_role": "admin",              // super_admin | admin | support
    "biz": {                            // memberships, max ~20 enforced at app layer
      "3f9c…-uuid": "owner",
      "77aa…-uuid": "marketing"
    }
  }
}
```

Rules:

- Claims are **authorization hints for RLS**, not the source of truth. The source of truth is the tables. Claims refresh on token refresh (≤1h); **revocation must be immediate**, so destructive-permission checks (staff removal, suspension) also verify against the table server-side.
- A user with >20 memberships (rare; agencies `[SCALE]`) falls back to table-lookup policies; the claim carries `"biz_overflow": true`.
- Never put PII, plan data, or anything display-oriented in claims.

### Claim helper functions (SQL)

```sql
-- schema: private (not exposed via PostgREST)
create schema if not exists private;

create or replace function private.jwt_biz_role(bid uuid)
returns text language sql stable as $$
  select coalesce(
    (auth.jwt()->'app_metadata'->'biz'->>bid::text),
    case when (auth.jwt()->'app_metadata'->>'biz_overflow')::boolean is true then
      (select role from public.business_staff
        where business_id = bid and user_id = auth.uid() and status = 'active')
    end
  )
$$;

create or replace function private.is_staff_of(bid uuid, min_roles text[])
returns boolean language sql stable as $$
  select private.jwt_biz_role(bid) = any(min_roles)
$$;

create or replace function private.is_admin()
returns boolean language sql stable as $$
  select coalesce((auth.jwt()->'app_metadata'->>'is_platform_admin')::boolean, false)
$$;
```

`stable` + claim-based means the planner can inline these; policies avoid per-row subqueries in the common path.

## RLS policy patterns

RLS is **enabled on every table in `public`**. Tables with no consumer/staff access path still get RLS with deny-all + service-role-only access. Four canonical patterns cover the whole schema; every policy in `20-data/` cites its pattern.

### P1 — Tenant-staff table (e.g. `products`, `campaigns`, `receipt_templates`)

```sql
alter table public.products enable row level security;

-- Staff read within tenant
create policy products_staff_select on public.products
  for select using (private.is_staff_of(business_id, array['owner','manager','marketing','staff']));

-- Writes restricted by role (matrix: 00-product/01)
create policy products_staff_write on public.products
  for insert with check (private.is_staff_of(business_id, array['owner','manager']));
create policy products_staff_update on public.products
  for update using (private.is_staff_of(business_id, array['owner','manager']))
  with check (business_id = (select business_id from public.products p2 where p2.id = id)); -- no tenant hopping

-- Public read of published rows (consumer app)
create policy products_public_select on public.products
  for select using (status = 'active' and deleted_at is null);
```

### P2 — Consumer-owned table (e.g. `favorites`, `user_devices`)

```sql
create policy favorites_owner_all on public.favorites
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
```

### P3 — Dual-audience table (e.g. `receipts`, `points_transactions`, `business_customers`)

```sql
-- Consumer sees own rows
create policy receipts_consumer_select on public.receipts
  for select using (user_id = auth.uid());
-- Tenant staff see rows for their business
create policy receipts_staff_select on public.receipts
  for select using (private.is_staff_of(business_id, array['owner','manager']));
-- NO insert/update policies for either audience: all writes go through
-- service-role code paths (workers, service layer) so the points/fraud
-- pipeline can't be bypassed. Consumers "insert" receipts via the API,
-- which validates then writes with service role.
```

### P4 — Platform table (e.g. `announcements`, `feature_flags`, `audit_logs`)

```sql
-- Published content readable by all authenticated (or anon where meant to be public)
create policy announcements_public on public.announcements
  for select using (status = 'published');
-- Admin management via service role or is_admin() policies; audit_logs: insert-only
-- via service role, select for private.is_admin() only (+ tenant-scoped owner view where specified).
```

## Service-role usage (the escape hatch, fenced)

The `service_role` key bypasses RLS. It is confined to:

| Context | Why | Fence |
|---|---|---|
| Queue workers | Cross-tenant batch work (OCR, notifications, expiry) | Workers live in `src/workers/`; lint rule forbids `createServiceClient()` outside `src/workers/**` and `src/lib/server/admin/**` |
| Admin services | Moderation/verification across tenants | Every call records an `audit_logs` row with acting admin + reason |
| Points engine writes | Ledger integrity (P3 above) | Only the points service module writes `points_transactions` |

Service-role key never reaches the client, Edge Middleware, or logs.

## Tenant lifecycle

- **Creation:** registering a business creates `businesses` (status `draft`) + `business_staff` owner row atomically (one RPC).
- **Suspension:** `businesses.status = 'suspended'` — RLS public-read policies all include `status = 'active'` checks via the business join where relevant; middleware blocks portal access; campaigns auto-pause (worker).
- **Deletion:** soft (`deleted_at`); hard purge job `[SCALE]` honoring PH Data Privacy Act retention rules (`15-security.md`).

## Data residency & partitioning (designed-for)

- All PKs are UUIDv7 (time-ordered) — partition-friendly and index-friendly.
- Future partitioned tables: `points_transactions`, `receipts`, `audit_logs`, `notifications` — by month on `created_at`, with `business_id` in every query predicate. Queries already always filter by tenant or time, so partition pruning will work without query rewrites.
- Read replicas `[SCALE]`: analytics queries flagged in the service layer (`readPreference: 'replica'`) so cutover is config.

## Testing tenancy (non-negotiable)

`51-testing-strategy.md` defines the RLS test suite: for every table, an automated matrix test signs in as (other-tenant owner, same-tenant each-role, consumer, anon) and asserts exactly the accesses the permission matrix allows. CI fails on any drift. A new table without RLS tests fails review by checklist.
