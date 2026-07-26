-- ============================================================================
-- 0032_integration_connections.sql
-- Tenant OAuth connections to external providers. Meta Business (Facebook
-- Page / Instagram business account) is the first and only provider at V1.
-- Source docs: docs/20-data/26-schema-amendments.md (A25.6, the ratified DDL),
-- docs/30-modules/42-integrations.md ("Meta Business OAuth" - token storage
-- decision, status lifecycle, refresh-on-read, deauthorize webhook),
-- docs/10-architecture/15-security.md (app-layer AES-256-GCM for
-- high-sensitivity columns, the pattern the TIN columns use),
-- docs/10-architecture/12-multi-tenancy-rls.md (P1 owner/manager pattern),
-- docs/00-product/01-personas-roles.md (who administers an integration).
-- Environment adaptations (same family as 0002/0007/0012/0017/0022):
--   * uuid_generate_v7() -> private.uuid_generate_v7()
--   * A25.6's "-- +audit, +deleted_at" shorthand expanded to the standard
--     audit quartet + the touch trigger + deleted_at
--   * no PG enums: provider and status are text + check constraints
--   * the staff policy uses the table-truth helper private.is_active_staff
--     (0010), not the claim-based helper: every other policy in this schema
--     does, and a mixed estate is how a policy silently stops matching
--   * the fences here are stated three ways, exactly as 0017 and 0022 state
--     theirs: policies gate row DML, privilege revokes gate what RLS never
--     sees (TRUNCATE) and the role RLS never applies to (service_role), and a
--     raising trigger gates the table owner and any future misgrant.
--
-- ----------------------------------------------------------------------------
-- THE ONE THING THIS FILE EXISTS TO GUARANTEE
-- ----------------------------------------------------------------------------
-- A25.6 notes that the token columns are "excluded from client DTOs". A DTO is
-- not a fence. A DTO is a promise made by whichever query happens to be
-- written next, and `select *` breaks it silently and permanently - the token
-- is in a response body, then in a client-side cache, then in a browser
-- devtools transcript, and nothing anywhere raised.
--
-- So the exclusion is stated at the privilege layer instead, with the same
-- mechanism 0017 used on `receipts` and 0021 used on `consumers`: the
-- table-level SELECT grant is revoked from anon and authenticated, and SELECT
-- is granted back on the non-secret columns ONLY. `access_token_encrypted` and
-- `refresh_token_encrypted` are not in that list and never will be. An owner
-- reading their own connection row gets every column their portal renders; the
-- moment any query names a token column as `authenticated` it raises 42501,
-- loudly, in development, on the first run.
--
-- Note for callers: `select *` on integration_connections as authenticated
-- raises 42501. Client reads must name their columns.
--
-- The tokens are additionally AES-256-GCM encrypted before they ever reach
-- this table (src/lib/crypto/token-cipher.ts), so the column grant is the
-- second fence and not the only one: a database-level leak yields ciphertext
-- whose key lives in the application environment, never in Postgres.
-- ============================================================================

-- ============================================================ integration_connections
create table public.integration_connections (
  id                 uuid primary key default private.uuid_generate_v7(),
  business_id        uuid not null references public.businesses(id) on delete cascade,
  -- Extend by migration, per A25.6. 'google_business' is carried from the
  -- ratified DDL even though nothing writes it yet: the value list is the
  -- amendment's, and adding a provider later should be a code change plus a
  -- one-line constraint change, not a rethink of the table.
  provider           text not null check (provider in ('meta_business','google_business')),
  -- Lifecycle per doc 42: 'connected' is the happy path; 'expired' and
  -- 'revoked' both render the portal's reconnect prompt (the difference is who
  -- ended it - the clock or the merchant/Meta); 'error' is a connection that
  -- failed a read for a reason that is neither.
  status             text not null default 'connected'
                       check (status in ('connected','expired','revoked','error')),
  external_account_id text not null,            -- FB Page ID / IG business account ID
  external_account_name text,
  -- The scopes actually granted, as returned by the provider - NOT the scopes
  -- requested. A user can deselect a permission in Meta's consent dialog, and
  -- an insights read that assumes `read_insights` was granted because we asked
  -- for it fails at call time with no explanation the merchant can act on.
  scopes             text[] not null default '{}',
  -- AES-256-GCM envelopes, not tokens. See the check constraints below and
  -- src/lib/crypto/token-cipher.ts for the byte layout.
  access_token_encrypted  bytea not null,
  -- Nullable because Meta has no refresh token in this flow: a long-lived
  -- token is re-exchanged from itself (doc 42's refresh-on-read), so this
  -- column stays null for every meta_business row. It is kept from A25.6
  -- because the next provider will have one.
  refresh_token_encrypted bytea,
  token_expires_at   timestamptz,
  last_synced_at     timestamptz,
  -- Operator-facing failure text for the reconnect prompt. GRANTED to the
  -- tenant owner below, so whatever a writer puts here is published to that
  -- tenant: it must be a summary ("Meta rejected the token"), never a provider
  -- response body, which can echo the request and therefore the token.
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references auth.users(id),
  updated_by         uuid references auth.users(id),
  -- +deleted_at per A25.6: disconnect is a soft delete (doc 42), because the
  -- row is the evidence that a tenant once granted us access and the audit row
  -- that records the disconnect points at this id.
  deleted_at         timestamptz,

  -- A25.6's uniqueness rule, unconditional exactly as ratified. Consequence,
  -- stated here rather than discovered by the first merchant who reconnects:
  -- a soft-deleted row STILL occupies its slot, so reconnecting the same Page
  -- collides (23505) rather than inserting a second row. That is the correct
  -- shape and the service is written to it - reconnect UPSERTS onto this
  -- constraint, clearing deleted_at and writing the fresh token, which also
  -- preserves the row's id and therefore the continuity of its audit history.
  -- A partial unique index over live rows only would have quietly permitted a
  -- second row per Page and split that history in two.
  constraint integration_connections_account_uniq
    unique (business_id, provider, external_account_id),

  -- ------------------------------------------------------------------
  -- THE PLAINTEXT FENCE.
  --
  -- `bytea` accepts anything, including the raw OAuth token, and a caller who
  -- forgets to encrypt produces a row that looks entirely normal. The envelope
  -- in src/lib/crypto/token-cipher.ts begins with a version byte, so the
  -- database can assert cheaply that what it was handed is an envelope: a Meta
  -- access token is printable ASCII (`EAAG...`), whose first byte is >= 0x20,
  -- and every other plausible accident (a UTF-8 string, a base64 string, a
  -- JSON blob) is too. 0x01 is not reachable by any of them.
  --
  -- This deliberately couples the schema to the envelope's first byte, and the
  -- coupling is the point: bumping the envelope version is a permanent,
  -- irreversible decision about data at rest (see that file's header), and
  -- having to widen this constraint in a migration is exactly the kind of
  -- deliberate step such a change should require. The list, not the equality,
  -- is what makes that widening a one-token edit that keeps old rows legal.
  -- ------------------------------------------------------------------
  constraint integration_connections_access_token_enveloped
    check (get_byte(access_token_encrypted, 0) in (1)),
  constraint integration_connections_refresh_token_enveloped
    check (refresh_token_encrypted is null
           or get_byte(refresh_token_encrypted, 0) in (1)),

  -- An 'error' status with nothing said about it is a dead end for the
  -- merchant and for support; a non-error status carrying stale error text is
  -- a reconnect prompt that never goes away. Pair them.
  constraint integration_connections_error_pairing
    check ((status = 'error') = (error is not null and btrim(error) <> ''))
);
alter table public.integration_connections enable row level security;
create trigger touch_integration_connections before update on public.integration_connections
  for each row execute function private.touch_updated_at();

-- A25.6's index, verbatim. Doubles as the FK index for business_id per doc 20's
-- convention (business_id leads), which matters here because the FK cascades on
-- tenant deletion.
create index integration_connections_biz_idx
  on public.integration_connections (business_id, provider);
-- amendment: FK indexes for the two audit actor columns, same convention.
create index integration_connections_created_by_idx
  on public.integration_connections (created_by);
create index integration_connections_updated_by_idx
  on public.integration_connections (updated_by);

-- ---------------------------------------------------------------- policies
-- P1: active owner/manager of the tenant read their own connections.
--
-- owner/manager rather than owner alone, and rather than the four-role catalog
-- read. Doc 42's connect flow names the audience directly ("owner/manager
-- clicks Connect in portal settings"), and it is the same pair 0017 settled on
-- for every business-configuration surface. Marketing and counter staff are
-- excluded: a connection row names the tenant's external accounts and the
-- exact permissions it granted a third party, which is administrative
-- configuration, not day-to-day operating data.
--
-- Soft-deleted rows are NOT filtered by the policy. The portal filters them
-- (`deleted_at is null`), but a policy predicate on deleted_at would make a
-- disconnected connection invisible to the very tenant that disconnected it,
-- and the reconnect upsert would then be writing over a row its own owner
-- cannot see. Visibility is a read concern; the fence here is tenancy.
create policy integration_connections_staff_select on public.integration_connections
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']));

-- NO client write policy of any kind, and no client write privilege either.
-- Connect, reconnect, disconnect and every status flip run server-side through
-- the service role, because each one of them either handles a token or decides
-- what a token is worth. A client-writable row here is a client-writable
-- `status`, which means a revoked connection could be flipped back to
-- 'connected' by the tenant it was revoked from; and a client-writable
-- `external_account_id` on a row keyed by a unique constraint is a way to
-- point one tenant's stored token at another tenant's Page.
--
-- Fence 1 of 3, the privilege layer: with no policy AND no privilege a client
-- write fails loudly with 42501 instead of silently matching zero rows (the
-- 0013/0017/0022 pattern).
revoke insert, update, delete, truncate on public.integration_connections from anon, authenticated;
-- service_role is the writer and keeps insert/update/delete: connect inserts,
-- reconnect and the status lifecycle update, and disconnect is an update
-- (soft delete). TRUNCATE goes, from service_role too - there is no caller for
-- the bulk form, and RLS never sees it, so the privilege is the only fence.
revoke truncate on public.integration_connections from anon, authenticated, service_role;

-- ---------------------------------------------------------------- column fence
-- THE TOKEN COLUMNS ARE NOT IN THIS GRANT AND MUST NEVER BE ADDED TO IT.
--
-- Everything else on the row is granted: the portal's connection card renders
-- the provider, the status, which Page was picked, the scopes actually granted,
-- when the token expires (so it can say "expires in 12 days" rather than
-- waiting for the failure), the last sync, and the error text behind a
-- reconnect prompt.
--
-- Unlike 0017's receipts grant there is no audience-intersection problem here:
-- owner and manager are the only client audience on this table and they need
-- exactly the same columns. The two withheld columns are needed by NO client
-- surface at all, now or later - a token is used by a server-side call to
-- Meta, and a browser has no use for one that is not a leak.
revoke select on public.integration_connections from anon, authenticated;
grant select (
  id, business_id, provider, status,
  external_account_id, external_account_name, scopes,
  token_expires_at, last_synced_at, error,
  created_at, updated_at, created_by, updated_by, deleted_at
) on public.integration_connections to authenticated;

-- ---------------------------------------------------------------- fence 2 of 2
-- Statement trigger. A bulk wipe is invisible to RLS and to any row trigger,
-- and the revokes above stop every app role - so this catches the table owner
-- and any future misgrant. Truncating this table would silently disconnect
-- every tenant on the platform with no audit row to say it happened, and the
-- tokens are not recoverable: every merchant would have to walk Meta's consent
-- dialog again to restore a connection nobody told them they had lost.
create or replace function private.integration_connections_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'integration_connections cannot be truncated (tenant OAuth grants)';
end
$$;

create trigger integration_connections_no_truncate
  before truncate on public.integration_connections
  for each statement execute function private.integration_connections_no_truncate();

-- ---------------------------------------------------- the fence NOT taken
-- There is deliberately NO row-level delete trigger here, unlike `receipts`
-- (0017) and `audit_logs` (0022), and the reason is worth writing down because
-- the omission looks like an oversight next to those two files.
--
-- A BEFORE DELETE row trigger fires on a CASCADE as well as on a direct
-- statement. A25.6 ratified `business_id ... on delete cascade`, which is a
-- decision that a tenant hard-delete takes its connections with it - the right
-- one, since a connection to a business that no longer exists is a token
-- nobody can revoke and nobody can audit. A no-hard-delete trigger would
-- silently convert that ratified cascade into a 23503-style dead end: the
-- tenant delete would raise, from a table nobody deleting a business is
-- thinking about, with an error message about integration connections.
--
-- The soft-delete rule (doc 42: "disconnect deletes the row (soft)") is
-- therefore held where it can be held without breaking the cascade: the client
-- roles have no DELETE privilege at all (the revoke above), and the only
-- server-side path that disconnects is a status/deleted_at UPDATE in
-- src/features/integrations/meta/server/repo.ts. And there is no UPDATE fence
-- either, deliberately: unlike audit_logs or ocr_results this table is mutable
-- by design - status transitions, token refresh, last_synced_at - so an
-- immutability trigger would block the pipeline it is meant to protect.
