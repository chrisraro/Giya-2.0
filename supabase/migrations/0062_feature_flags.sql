-- ============================================================================
-- 0062_feature_flags.sql
-- `feature_flags`: doc 38 section 1's kill switch table, and the table doc 25
-- always specified but migration 0000b dropped as legacy cruft before this
-- schema existed (see that file's header). Nothing in `public` has read it
-- since; this migration is the first time it exists in THIS schema.
--
-- Source docs: docs/20-data/25-schema-platform.md (`key`, `description`,
-- `is_enabled`, `rollout` jsonb - "+audit"), docs/30-modules/38-ai-rag-
-- platform.md section 1 (the three AI kill-switch keys, 30s cache),
-- docs/30-modules/31-admin-portal.md section 7 (`/admin/flags`, evaluation
-- semantics), docs/10-architecture/12-multi-tenancy-rls.md P4 (platform table
-- pattern).
--
-- ---------------------------------------------------------------------------
-- WHO MAY SELECT, DECIDED DELIBERATELY (the brief asks for this explicitly)
-- ---------------------------------------------------------------------------
-- Doc 31 section 7's evaluation semantics are written for a build where the
-- consumer AI assistant exists and needs to hide its own entry point
-- client-side ("rollout.percent", "beta cohort", ...). That build is not this
-- one: `/api/v1/ai/chat` is undesigned, there is no assistant UI to hide, and
-- doc 33's "hidden unless feature_flags key ai_assistant enabled" describes a
-- screen this codebase does not have. The ONLY two readers that exist today
-- are `src/lib/ai/llm.ts` (the gateway's kill-switch check, server-only,
-- already exists as the reason this migration exists) and `/admin/flags`
-- (the toggle screen, service-role backed by the app-layer super_admin gate
-- - see `src/features/admin/access.ts` and `flags.ts`, same pattern as every
-- sibling admin surface: `jobs.ts`, `consequences.ts`).
--
-- Granting `authenticated` a client-side read today would publish rollout
-- percentages and kill-switch state to any signed-in session for a
-- capability with zero client consumers, and it is exactly backwards from
-- this table's own purpose: `rollout` on a NOT-YET-BUILT feature could name
-- specific `business_ids` under a beta cohort, and there is no argument that
-- a beta list needs to be public before the feature it gates exists. So this
-- follows the STRICTER precedent already set in this schema - `jobs` (0029)
-- and `settings` platform rows (0017) - over doc 25's own "read all
-- authenticated" comment: RLS enabled, ZERO policies, privileges revoked
-- underneath so the denial is loud (42501), not a silent empty set. When a
-- client surface that actually needs to evaluate a flag ships (the assistant
-- entry point, `offline_sync`), the correct move is an explicit, narrow
-- policy for that key - never a blanket "authenticated may read every flag"
-- grant, which is exactly how doc 25's comment would leak `rollout.beta`
-- cohort lists for keys nobody built a policy review for.
--
-- Environment adaptations, same family as 0017/0022/0029:
--   * uuid_generate_v7() -> private.uuid_generate_v7() (not used here: `key`
--     is the primary key, per doc 25, so there is no surrogate id at all)
--   * doc 25's "-- +audit" shorthand expanded to the standard audit columns
--     + touch trigger, same shape as 0017's `settings` table (its nearest
--     sibling: platform-wide config, service-role write, no deleted_at)
--   * the fence is stated three ways for the same reason 0029 states jobs'
--     three ways: RLS gates row DML only, privilege revokes gate what RLS
--     never sees (TRUNCATE) and the role RLS never applies to (service_role),
--     and the statement trigger gates the table owner and any future misgrant
-- ============================================================================

-- ============================================================ feature_flags
create table public.feature_flags (
  -- Doc 25: `key text primary key`. A human-chosen slug ('ai_parse_assist'),
  -- not a uuid - there is one row per feature, addressed by name in code
  -- (src/lib/flags.ts) and in doc 38's own table, so a surrogate id would
  -- only be a second name for the same thing.
  key          text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  description  text not null check (btrim(description) <> ''),
  is_enabled   boolean not null default false,
  -- {percent:25, business_ids:[…], plans:["growth"], beta:true} - doc 25 and
  -- doc 31 section 7's evaluation ladder. `src/lib/flags.ts` in THIS slice
  -- reads only `is_enabled` (the kill switch); `rollout` is carried and
  -- persisted so the column exists for the [V1] staged-rollout reader
  -- without a second migration, but nothing reads it yet - see that file's
  -- header for why "unread" is the honest word and not "unused".
  rollout      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),
  updated_by   uuid references auth.users(id)
);
alter table public.feature_flags enable row level security;
create trigger touch_feature_flags before update on public.feature_flags
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------- policies
-- NONE. Deliberately - see the header above for the argument. RLS is enabled
-- so the absence of a policy is a DENY rather than an oversight (mirrors
-- 0029's own reasoning for `jobs`, restated there at length).

-- ---------------------------------------------------------------- fence 1 of 3
-- Privilege layer, client roles. Supabase grants every privilege on a new
-- public table to anon and authenticated by default; without this a client
-- reaches RLS and gets a polite empty set. Revoked so it is 42501 instead -
-- "you may not look at this" and "there is nothing here" are different
-- answers and a kill-switch table only has one true one.
revoke select, insert, update, delete, truncate on public.feature_flags
  from anon, authenticated;

-- ---------------------------------------------------------------- fence 2 of 3
-- Privilege layer, service_role. SELECT / INSERT / UPDATE stay: the gateway
-- reads (`src/lib/flags.ts`), the admin screen reads and toggles
-- (`is_enabled` only, via `src/features/admin/flags.ts`), and a future
-- registry seed inserts a new key. DELETE and TRUNCATE go - a flag that is
-- no longer wired is turned off (`is_enabled = false`) and left as a record
-- of what once existed, the same "never delete, only supersede" posture
-- 0029 takes on `jobs` and 0022 takes on `audit_logs`.
revoke delete, truncate on public.feature_flags from service_role;

-- ---------------------------------------------------------------- fence 3 of 3
-- Statement trigger, restating the TRUNCATE revoke at the layer that
-- survives a re-grant. A row-level trigger never fires on TRUNCATE at all,
-- so this is the layer that catches the table owner or any future misgrant -
-- same shape as 0022's and 0029's own no-truncate triggers.
create or replace function private.feature_flags_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'feature_flags cannot be truncated (the kill-switch registry)';
end
$$;

create trigger feature_flags_no_truncate
  before truncate on public.feature_flags
  for each statement execute function private.feature_flags_no_truncate();

-- ---------------------------------------------------------------- seed
-- Doc 38 section 1's three AI kill-switch keys. Seeded ENABLED, not
-- disabled: before this migration there was no flag at all and parse-assist
-- (the only one of the three actually wired to a live call in this
-- codebase - see `src/features/receipts/server/process.ts#runParseAssist`)
-- ran unconditionally whenever GROQ_API_KEY was configured. A kill switch
-- exists so an operator can turn a feature OFF on a bad day; it must not
-- silently turn a working feature off on THIS day, the day the switch is
-- installed. This is a deliberately different question from "what does a
-- caller see when the row cannot be read at all", which `src/lib/flags.ts`
-- answers `false` (fails closed) for every key - see that file's header for
-- the argument. The seed is the deploy-time DEFAULT; the fail-safe is the
-- READ-TIME uncertainty answer. They point in different directions on
-- purpose: today's row says "on", and losing the ability to confirm that
-- says "assume off".
insert into public.feature_flags (key, description, is_enabled) values
  ('ai_parse_assist',
   'Doc 36 Stage 7 tier 3: LLM fill-gap extraction for receipt parsing. Off (or unreadable) means the gateway never calls the model and every receipt is priced from the deterministic parser alone.',
   true),
  ('ai_assistant',
   'Doc 38 section 4: the consumer-facing AI assistant chat (not yet built in this codebase). Off means the assistant surface stays hidden and no model call is made once it ships.',
   true),
  ('ai_analytics',
   'Doc 38 section 9 [SCALE]: AI-generated campaign suggestions and trend narratives (not yet built). Off means no model call is made once it ships.',
   true)
on conflict (key) do nothing;
