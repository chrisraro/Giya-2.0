# Supabase database assets

SQL for the Giya database lives here. Migrations are plain SQL files, ordered
by numeric prefix, and each file is applyable top to bottom in a single pass.

```
supabase/
  migrations/
    0001_foundations.sql    extensions, private schema, UUIDv7, claim helpers
    0002_identity.sql       identity tables, RLS policies, ref-table seeds
    0003_auth_plumbing.sql  signup trigger, register_business RPC, JWT hook
  tests/
    rls_identity_smoke.sql  pgTAP smoke suite (transaction-wrapped, rolls back)
```

## How migrations are applied

- **Now (MVP bootstrap):** applied to the hosted project via the Supabase MCP
  `apply_migration` tool, one file at a time, in numeric order. The files here
  are the source of truth; nothing is written to the database that is not in
  this directory.
- **Later (CLI/CI):** the same files migrate into the Supabase CLI workflow
  (`supabase db push` / `supabase migration up`) and a CI job that applies
  pending migrations on merge to `main`. File naming stays compatible: the CLI
  accepts the `NNNN_name.sql` prefix ordering used here.

## Manual dashboard step: enable the token hook (required)

Migration 0003 creates `private.custom_access_token_hook`, but Supabase only
runs it after it is enabled in the dashboard:

1. Open the project dashboard.
2. Go to **Authentication -> Hooks (Beta)**.
3. Under **"Customize Access Token (JWT) Claims hook"**, select
   **`private.custom_access_token_hook`**.
4. Click **Enable**.

Until this is done, JWTs are issued without the `biz` / `is_platform_admin`
claims and every staff/admin RLS policy evaluates to false (deny). Consumers
(P2 self policies) are unaffected.

After changing hook configuration, existing sessions keep their old claims
until the next token refresh (up to 1 hour); sign out and back in to see new
claims immediately.

## Dev note: disable email confirmation (local/dev projects only)

For fast dev signups without a mailbox loop:

1. Open the project dashboard.
2. Go to **Authentication -> Sign In / Up -> Email**.
3. Toggle **"Confirm email"** off.

Leave confirmation ON for the production project.

## Running the pgTAP suite

`0001_foundations.sql` installs pgTAP into the `extensions` schema. The suite
is transaction-wrapped (`begin ... rollback`) and leaves no data behind:

```sh
psql "$DATABASE_URL" -f supabase/tests/rls_identity_smoke.sql
```

Run it as a privileged role (`postgres`); the suite switches to
`authenticated` / `anon` with `set local role` plus `request.jwt.claims` to
simulate end users. Via MCP, the file body can be run with `execute_sql`
(it manages its own transaction).

## Conventions enforced in these files

- Every table enables RLS immediately after creation; deny-all tables carry a
  comment explaining why they have no policies.
- Every `security definer` function pins `set search_path = ''` and fully
  qualifies object references.
- Policies cite their pattern (P1-P4 per `docs/10-architecture/12-multi-tenancy-rls.md`).
- Deviations from the schema docs are marked with `-- amendment:` comments.
- Seeds are idempotent (`on conflict do nothing`) keyed on stable natural keys.
