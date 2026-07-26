-- ============================================================================
-- rls_integration_connections_smoke.sql (pgTAP)
-- Smoke tests for 0032 integration_connections.
--
-- THE ASSERTION THIS FILE EXISTS FOR is number 3 and 4: an owner - the most
-- privileged client audience this table has, reading their OWN tenant's row -
-- gets 42501 when they name `access_token_encrypted` or
-- `refresh_token_encrypted`, while every other column on the same row reads
-- cleanly. A25.6's note says the token columns are "excluded from client
-- DTOs"; a DTO is a promise, and this suite is the proof. Assertion 6 closes
-- the obvious hole in it: `select *` raises too, so the fence cannot be walked
-- around by a query that never names a token column at all.
--
-- Also covered: cross-tenant denial, the owner/manager role list and the
-- marketing narrowing, the consumer and anon rows of doc 12's matrix, the
-- absence of any client write path, the service_role privilege split, the
-- no-truncate statement trigger, and the four check constraints (the plaintext
-- envelope fence, the error/status pairing, the provider and status vocabulary)
-- plus the account uniqueness rule that reconnect upserts onto.
--
-- Runs entirely inside one transaction and rolls back. Execute as a privileged
-- role (postgres) against a database with migrations 0001-0032 applied. pgTAP
-- lives in the extensions schema.
--
-- Fixture strategy: mirror rls_audit_logs_smoke.sql. Insert directly into
-- auth.users (the on_auth_user_created trigger creates profiles + consumers),
-- create two tenants via register_business under set-local-role authenticated
-- capturing the returned business id, then add the manager and marketing
-- members and seed connection rows as the privileged role, which stands in for
-- the service-role writer - the only writer this table has.
--
-- HARD RULE, carried over from the receipts and audit suites: every fixture id
-- is captured off its own "insert ... returning" CTE. Nothing is looked up by
-- name or by any other global predicate over a whole table - this database
-- also holds live E2E data, and a live row sharing a fixture's
-- external_account_id would silently be picked up instead of the fixture's own
-- row. Every count assertion is likewise scoped by a fixture id or a fixture
-- business id, never left as a bare count over a table.
--
-- The token bytea values below are FAKE ENVELOPES, not encrypted anything:
-- 0x01 (the envelope version byte src/lib/crypto/token-cipher.ts writes),
-- then arbitrary bytes. That is exactly enough to satisfy the plaintext fence,
-- and this file must not contain a real ciphertext for the same reason it must
-- not contain a real token.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(33);

-- ---------------------------------------------------------------- fixtures
-- Five fixed test users: two business owners (the cross-tenant probe), the
-- manager of tenant 1 (in the policy's role list), the marketing member of
-- tenant 1 (the narrowing probe - an active member who is NOT an audience for
-- a tenant's external credentials), and one consumer.
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('e1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-integ-owner1@example.com', '{"full_name": "Integ Owner One"}'::jsonb),
  ('e2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-integ-owner2@example.com', '{"full_name": "Integ Owner Two"}'::jsonb),
  ('e3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-integ-manager@example.com', '{"full_name": "Integ Manager"}'::jsonb),
  ('e4444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'giya-integ-marketing@example.com', '{"full_name": "Integ Marketing"}'::jsonb),
  ('e5555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated',
   'giya-integ-consumer@example.com', '{"full_name": "Integ Consumer"}'::jsonb);

-- owner1 registers tenant 1; register_business returns the new business uuid
-- (0003), so the id is captured straight from the call, never looked up.
select set_config('request.jwt.claims',
  '{"sub": "e1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz1',
  (select public.register_business('Integ Cafe', 'cafe', 'cebu', '1 Token Street')::text),
  true);
reset role;

-- owner2 registers tenant 2 (the cross-tenant probe)
select set_config('request.jwt.claims',
  '{"sub": "e2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz2',
  (select public.register_business('Integ Rival', 'restaurant', 'manila', '2 Grant Ave')::text),
  true);
reset role;

-- the two extra members of tenant 1 (privileged fixture: staff membership
-- writes are service-role only until the staff module ships).
insert into public.business_staff (business_id, user_id, role, status)
values
  (current_setting('test.biz1')::uuid,
   'e3333333-3333-4333-8333-333333333333', 'manager', 'active'),
  (current_setting('test.biz1')::uuid,
   'e4444444-4444-4444-8444-444444444444', 'marketing', 'active');

-- connection rows, seeded as the privileged role (stands in for the
-- service-role writer). One insert, one returning CTE.
--   ic1 - tenant 1, connected, the row every read assertion below targets
--   ic2 - tenant 2, connected (the cross-tenant probe)
--   ic3 - tenant 1, a DISCONNECTED row (deleted_at set). The policy
--         deliberately does not filter deleted_at, so this proves the tenant
--         can still see the record of a grant it revoked.
with ins as (
  insert into public.integration_connections
    (business_id, provider, status, external_account_id, external_account_name,
     scopes, access_token_encrypted, token_expires_at, deleted_at)
  values
    (current_setting('test.biz1')::uuid, 'meta_business', 'connected',
     'integ-fixture-page-1', 'Integ Cafe Page',
     array['pages_show_list','pages_read_engagement','read_insights','instagram_basic'],
     '\x0102763101deadbeefdeadbeefdeadbeefdeadbeef'::bytea,
     now() + interval '60 days', null),
    (current_setting('test.biz2')::uuid, 'meta_business', 'connected',
     'integ-fixture-page-2', 'Integ Rival Page',
     array['pages_show_list'],
     '\x0102763102deadbeefdeadbeefdeadbeefdeadbeef'::bytea,
     now() + interval '60 days', null),
    (current_setting('test.biz1')::uuid, 'meta_business', 'connected',
     'integ-fixture-page-3', 'Integ Cafe Old Page',
     array['pages_show_list'],
     '\x0102763103deadbeefdeadbeefdeadbeefdeadbeef'::bytea,
     now() + interval '60 days', now())
  returning id, external_account_id
)
select
  set_config('test.ic1', (select id::text from ins where external_account_id = 'integ-fixture-page-1'), true),
  set_config('test.ic2', (select id::text from ins where external_account_id = 'integ-fixture-page-2'), true),
  set_config('test.ic3', (select id::text from ins where external_account_id = 'integ-fixture-page-3'), true);

-- ---------------------------------------------------------------- owner view
select set_config('request.jwt.claims',
  '{"sub": "e1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

-- 1. the owner of tenant 1 reads their own tenant's connections (P1). Two rows:
--    the live one and the disconnected one, because the policy fences tenancy
--    and not visibility - see the policy note in 0032.
select is(
  (select count(*)::int from public.integration_connections
    where business_id = current_setting('test.biz1')::uuid),
  2,
  'owner reads own-tenant connection rows including soft-deleted (P1 owner select)');

-- 2. and none of tenant 2's. A connection row names the tenant's external
--    accounts and the exact permissions it granted a third party.
select is(
  (select count(*)::int from public.integration_connections
    where business_id = current_setting('test.biz2')::uuid),
  0,
  'owner cannot read another tenant connection rows (P1 cross-tenant deny)');

-- 3. THE ASSERTION. The row is the owner's own, the policy admits it, and the
--    column still raises: the table-level SELECT grant is gone and the token
--    columns are not in the column allowlist. This is what makes "tokens are
--    never selected by a client-reachable query" a property of the database
--    rather than a property of whichever query was written most recently.
select throws_ok(
  $$select access_token_encrypted from public.integration_connections
     where business_id = current_setting('test.biz1')::uuid$$,
  '42501',
  null,
  'owner cannot select access_token_encrypted even on own-tenant rows (column grant fence)');

-- 4. same for the refresh token column (null for every meta_business row, but
--    the fence is on the column, not on the value)
select throws_ok(
  $$select refresh_token_encrypted from public.integration_connections
     where business_id = current_setting('test.biz1')::uuid$$,
  '42501',
  null,
  'owner cannot select refresh_token_encrypted even on own-tenant rows (column grant fence)');

-- 5. while the whole allowlist - everything the portal connection card renders
--    - reads cleanly. A fence that also broke the feature would just get
--    reverted.
select lives_ok(
  $$select id, business_id, provider, status,
           external_account_id, external_account_name, scopes,
           token_expires_at, last_synced_at, error,
           created_at, updated_at, created_by, updated_by, deleted_at
      from public.integration_connections
     where business_id = current_setting('test.biz1')::uuid$$,
  'owner reads every allowlisted integration_connections column');

-- 6. and `select *` raises, which is the assertion that stops the fence being
--    walked around by a query that never names a token column
select throws_ok(
  $$select * from public.integration_connections
     where business_id = current_setting('test.biz1')::uuid$$,
  '42501',
  null,
  'select * on integration_connections raises 42501 for authenticated');

-- 7. no client insert policy AND no client insert privilege: an owner cannot
--    forge a connection row for their own tenant
select throws_ok(
  $$insert into public.integration_connections
      (business_id, provider, external_account_id, access_token_encrypted)
    values (current_setting('test.biz1')::uuid, 'meta_business', 'forged-page',
            '\x01ff00ff00ff00ff00ff00ff00ff00ff00ff00ff'::bytea)$$,
  '42501',
  null,
  'owner cannot insert a connection row (service-role write fence)');

-- 8. and cannot update one. This is the fence that matters most after the
--    column grant: a client-writable `status` means a tenant can flip a
--    connection Meta revoked back to 'connected'.
select throws_ok(
  $$update public.integration_connections set status = 'connected'
     where id = current_setting('test.ic1')::uuid$$,
  '42501',
  null,
  'owner cannot update a connection row (service-role write fence)');

-- 9. nor delete one
select throws_ok(
  $$delete from public.integration_connections where id = current_setting('test.ic1')::uuid$$,
  '42501',
  null,
  'owner cannot delete a connection row (service-role write fence)');

reset role;

-- ---------------------------------------------------------------- manager
-- doc 42 names owner/manager as the connect audience, so unlike audit_logs the
-- manager IS in the role list here. Asserted rather than assumed, because the
-- two neighbouring tables disagree with each other on exactly this point.
select set_config('request.jwt.claims',
  '{"sub": "e3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;

-- 10.
select is(
  (select count(*)::int from public.integration_connections
    where business_id = current_setting('test.biz1')::uuid),
  2,
  'manager reads own-tenant connection rows (doc 42 connect audience)');

-- 11. the column fence is a ROLE-level grant, so it binds the manager exactly
--     as it binds the owner. Stated because it would be easy to assume the
--     fence is somehow tied to the policy.
select throws_ok(
  $$select access_token_encrypted from public.integration_connections
     where business_id = current_setting('test.biz1')::uuid$$,
  '42501',
  null,
  'manager cannot select access_token_encrypted either (column grant is role-wide)');

reset role;

-- ---------------------------------------------------------------- marketing
-- An ACTIVE member of tenant 1 whose role is outside the policy's list. This
-- is the narrowing: which external accounts a tenant connected, and what
-- permissions it handed a third party, is administrative configuration.
select set_config('request.jwt.claims',
  '{"sub": "e4444444-4444-4444-8444-444444444444", "role": "authenticated"}', true);
set local role authenticated;

-- 12.
select is(
  (select count(*)::int from public.integration_connections
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'marketing member of the tenant reads no connection rows (owner/manager narrowing)');

reset role;

-- ---------------------------------------------------------------- consumer
select set_config('request.jwt.claims',
  '{"sub": "e5555555-5555-4555-8555-555555555555", "role": "authenticated"}', true);
set local role authenticated;

-- 13. no consumer policy at all
select is(
  (select count(*)::int from public.integration_connections
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'consumer reads no connection rows (no consumer policy)');

-- 14.
select throws_ok(
  $$insert into public.integration_connections
      (business_id, provider, external_account_id, access_token_encrypted)
    values (current_setting('test.biz1')::uuid, 'meta_business', 'consumer-forged',
            '\x01ff00ff00ff00ff00ff00ff00ff00ff00ff00ff'::bytea)$$,
  '42501',
  null,
  'consumer cannot insert a connection row');

reset role;

-- ---------------------------------------------------------------- anon
-- doc 12 requires the anon row of the matrix to be stated explicitly, not
-- inferred from "no policy". The table-level select grant is gone and anon gets
-- no column allowlist, so anon does not get an empty result - it gets 42501.
set local role anon;

-- 15.
select throws_ok(
  $$select id from public.integration_connections$$,
  '42501',
  null,
  'anon cannot select integration_connections at all (table grant revoked, no column allowlist)');

-- 16.
select throws_ok(
  $$insert into public.integration_connections
      (business_id, provider, external_account_id, access_token_encrypted)
    values (current_setting('test.biz1')::uuid, 'meta_business', 'anon-forged',
            '\x01ff00ff00ff00ff00ff00ff00ff00ff00ff00ff'::bytea)$$,
  '42501',
  null,
  'anon cannot insert a connection row');

reset role;

-- ---------------------------------------------------------------- privilege fence
-- RLS gates row DML only. It never sees TRUNCATE and it never applies to
-- service_role, so the privilege layer is the only fence for both. Each
-- assertion aggregates the privileges a role actually still holds into a
-- sorted string, so a failure names the exact privilege that leaked.

-- 17/18.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('anon', 'public.integration_connections', p)),
  null::text,
  'anon holds no write privilege on integration_connections');

select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('authenticated', 'public.integration_connections', p)),
  null::text,
  'authenticated holds no write privilege on integration_connections');

-- 19. anon has no read surface of any kind
select ok(
  not has_table_privilege('anon', 'public.integration_connections', 'SELECT'),
  'anon holds no SELECT privilege on integration_connections (no column allowlist granted)');

-- 20/21. THE COLUMN FENCE AT THE PRIVILEGE LAYER. The pair of assertions the
--        whole slice is judged on: not merely "the query failed", but "the
--        privilege is not held", which is the thing a future migration would
--        have to explicitly undo.
select ok(
  not has_column_privilege('authenticated', 'public.integration_connections',
                           'access_token_encrypted', 'SELECT'),
  'authenticated holds no SELECT privilege on integration_connections.access_token_encrypted');

select ok(
  not has_column_privilege('authenticated', 'public.integration_connections',
                           'refresh_token_encrypted', 'SELECT'),
  'authenticated holds no SELECT privilege on integration_connections.refresh_token_encrypted');

-- 22. the positive control: the fence is on two columns, not on the table.
--     Without this a migration that revoked everything would pass 20 and 21
--     while breaking the feature.
select ok(
  has_column_privilege('authenticated', 'public.integration_connections', 'status', 'SELECT'),
  'authenticated keeps SELECT on integration_connections.status (the fence is two columns, not the table)');

-- 23. service_role is the writer: insert (connect), update (status lifecycle,
--     token refresh, soft delete) and delete stay; TRUNCATE goes, because
--     there is no caller for the bulk form and RLS never sees it.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('service_role', 'public.integration_connections', p)),
  'DELETE,INSERT,UPDATE',
  'service_role keeps insert/update/delete on integration_connections and no truncate');

-- ---------------------------------------------------------------- service_role live
set local role service_role;

-- 24. the writer can write, tokens included
select lives_ok(
  $$insert into public.integration_connections
      (business_id, provider, external_account_id, external_account_name,
       scopes, access_token_encrypted)
    values (current_setting('test.biz1')::uuid, 'meta_business',
            'integ-fixture-page-4', 'Integ Cafe Second Page',
            array['pages_show_list'],
            '\x0102763104deadbeefdeadbeefdeadbeefdeadbeef'::bytea)$$,
  'service_role inserts a connection row (it is the writer)');

-- 25. and reads the token back, which is the whole point of the split: the
--     server-side path that calls Meta needs the ciphertext, and it is the
--     only role that can have it.
select lives_ok(
  $$select access_token_encrypted from public.integration_connections
     where id = current_setting('test.ic1')::uuid$$,
  'service_role reads access_token_encrypted (the only role that can)');

reset role;

-- ---------------------------------------------------------------- truncate fence
-- 26. The revokes strip TRUNCATE from anon, authenticated AND service_role, so
--     this trigger is the layer that catches whoever still holds the privilege
--     - the table owner, any future misgrant. Truncating this table would
--     disconnect every tenant on the platform with no audit row saying so, and
--     the tokens are not recoverable.
select throws_ok(
  $$truncate public.integration_connections$$,
  'P0001',
  null,
  'integration_connections cannot be truncated (statement-level trigger)');

-- ---------------------------------------------------------------- constraints
-- 27. THE PLAINTEXT FENCE. A raw Meta access token is printable ASCII
--     ("EAAG..."), so its first byte can never be 0x01. A caller who forgets to
--     encrypt gets 23514 instead of a row that looks entirely normal.
select throws_ok(
  $$insert into public.integration_connections
      (business_id, provider, external_account_id, access_token_encrypted)
    values (current_setting('test.biz1')::uuid, 'meta_business', 'integ-plaintext',
            convert_to('EAAGm0PX4ZCpsBAplaintexttoken', 'UTF8'))$$,
  '23514',
  null,
  'a plaintext token is refused by the envelope-version check');

-- 28. pinned to the constraint name, so it cannot pass for the wrong reason
select throws_like(
  $$insert into public.integration_connections
      (business_id, provider, external_account_id, access_token_encrypted,
       refresh_token_encrypted)
    values (current_setting('test.biz1')::uuid, 'meta_business', 'integ-plaintext-refresh',
            '\x0102763199deadbeefdeadbeefdeadbeefdeadbeef'::bytea,
            convert_to('a-plaintext-refresh-token', 'UTF8'))$$,
  '%integration_connections_refresh_token_enveloped%',
  'a plaintext refresh token is refused by its own envelope-version check');

-- 29. account uniqueness - the constraint reconnect UPSERTS onto. A second row
--     for the same Page would split the connection's audit history in two.
select throws_ok(
  $$insert into public.integration_connections
      (business_id, provider, external_account_id, access_token_encrypted)
    values (current_setting('test.biz1')::uuid, 'meta_business', 'integ-fixture-page-1',
            '\x0102763105deadbeefdeadbeefdeadbeefdeadbeef'::bytea)$$,
  '23505',
  null,
  'one row per (business, provider, external account) - including soft-deleted rows');

-- 30/31. the error/status pairing, both directions: an 'error' with nothing
--        said about it is a dead end for support, and stale error text on a
--        healthy connection is a reconnect prompt that never clears.
select throws_like(
  $$insert into public.integration_connections
      (business_id, provider, external_account_id, status, access_token_encrypted)
    values (current_setting('test.biz1')::uuid, 'meta_business', 'integ-mute-error',
            'error', '\x0102763106deadbeefdeadbeefdeadbeefdeadbeef'::bytea)$$,
  '%integration_connections_error_pairing%',
  'status error with no error text is refused');

select throws_like(
  $$insert into public.integration_connections
      (business_id, provider, external_account_id, status, error, access_token_encrypted)
    values (current_setting('test.biz1')::uuid, 'meta_business', 'integ-stale-error',
            'connected', 'stale', '\x0102763107deadbeefdeadbeefdeadbeefdeadbeef'::bytea)$$,
  '%integration_connections_error_pairing%',
  'error text on a non-error status is refused');

-- 32/33. the two vocabularies. Both are text + check rather than PG enums (the
--        house rule), so the constraint is the only thing keeping a typo out.
select throws_ok(
  $$insert into public.integration_connections
      (business_id, provider, external_account_id, access_token_encrypted)
    values (current_setting('test.biz1')::uuid, 'facebook', 'integ-bad-provider',
            '\x0102763108deadbeefdeadbeefdeadbeefdeadbeef'::bytea)$$,
  '23514',
  null,
  'an unregistered provider is refused');

select throws_ok(
  $$insert into public.integration_connections
      (business_id, provider, external_account_id, status, access_token_encrypted)
    values (current_setting('test.biz1')::uuid, 'meta_business', 'integ-bad-status',
            'disconnected', '\x0102763109deadbeefdeadbeefdeadbeefdeadbeef'::bytea)$$,
  '23514',
  null,
  'an unregistered status is refused');

select * from finish();
rollback;
