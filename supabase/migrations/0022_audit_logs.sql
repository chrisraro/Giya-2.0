-- ============================================================================
-- 0022_audit_logs.sql
-- audit_logs: the platform's append-only record of who did what to which
-- entity, with the before and after state. Pulled forward from doc 25 by the
-- receipt review queue slice, which is the first surface that writes it; the
-- remaining platform tables (jobs, exports, feedback, notifications, the
-- analytics rollups) land with their own slices.
-- Source docs: docs/20-data/25-schema-platform.md (canonical DDL + the three
-- indexes), docs/10-architecture/15-security.md ("Audit logging": what must be
-- captured, and "Authorization": admin actions on tenant data always require a
-- recorded reason), docs/30-modules/37-fraud-detection.md (the reviewer action
-- -> audit mapping and the consequences ladder, "every step is audited"),
-- docs/00-product/01-personas-roles.md ("View audit logs (own tenant)" row of
-- the permission matrix), docs/10-architecture/12-multi-tenancy-rls.md (P1),
-- docs/superpowers/specs/2026-07-25-receipt-review-queue-design.md section 3.
-- Environment adaptations (same family as 0002/0007/0012/0017):
--   * uuid_generate_v7() -> private.uuid_generate_v7()
--   * no PG enums: actor_kind is text + a check constraint
--   * the staff policy uses the table-truth helper private.is_active_staff
--     (0010), never the claim-based helper from doc 12 - the custom access
--     token hook is not enabled on this project
--   * NO audit columns and NO touch trigger on this table: it is append-only,
--     so updated_at/updated_by/deleted_at would describe a mutation that can
--     never happen. Same shape as points_transactions (0012) and ocr_results /
--     fraud_signals (0017).
--   * the write fences here are stated three ways, exactly as 0017 states its
--     evidence fences, because no single layer covers them: policies gate row
--     DML, privilege revokes gate what RLS never sees (TRUNCATE) and the role
--     RLS never applies to (service_role), and raising triggers gate the table
--     owner and any future misgrant. Every fence below says which layer it is.
--     For this table the three layers are not belt-and-braces pedantry: an
--     audit trail that can be edited is not evidence of anything, and the
--     single most valuable row in it to erase is the one recording the abuse.
-- ============================================================================

-- ============================================================ audit_logs
-- One row per state change that matters (doc 15 "Coverage"): verification
-- decisions, role changes, campaign lifecycle, manual points adjustments,
-- reward inventory changes, suspensions, feature-flag flips, signed-URL grants
-- on documents, admin logins - and, from this slice, every receipt review
-- decision. Insert-only for every role including service_role's mutation
-- privileges. RLS: P1 read for the tenant owner; no consumer policy, no client
-- write policy of any kind.
create table public.audit_logs (
  id           uuid primary key default private.uuid_generate_v7(),
  -- null = system/worker (doc 25). The FK is deliberately kept from the doc: an
  -- audit row whose actor cannot be resolved to a real identity is not much of
  -- an audit row, and points_transactions.actor_id (0012) references profiles
  -- the same way. Consequence, stated rather than discovered later: profiles.id
  -- cascades from auth.users, so hard-deleting an auth user who has ever acted
  -- now raises 23503 instead of silently cascading. That is the correct failure
  -- mode here - doc 15's account-deletion flow is a soft delete plus a PII
  -- purge with "ledger rows anonymized not deleted", never a row removal, and
  -- the same argument applies verbatim to the security record.
  actor_id     uuid references public.profiles(id),
  actor_kind   text not null check (actor_kind in ('user','admin','system','worker')),
  -- Denormalized snapshot of the actor's role AT THE TIME OF THE ACTION, and
  -- deliberately free text with no FK and no enum. business_staff.role is live
  -- data: a member demoted or removed tomorrow must not retroactively rewrite
  -- what role they held when they approved this receipt, and a future role
  -- rename must not invalidate history. History is a snapshot, not a join.
  actor_role   text,
  -- No FK, per doc 25: the log survives a tenant hard-purge. Null means a
  -- platform-level action with no tenant (see the policy note below for what
  -- that implies for readership).
  business_id  uuid,
  -- Verb registry: 'receipt.review_approved', 'campaign.activated',
  -- 'staff.role_changed', ... See the constraint note below for why this is a
  -- shape constraint and not a value enum.
  action       text not null,
  entity_type  text not null,                          -- table name of the subject row
  -- No FK, and there cannot be one: the subject may live in any table, and the
  -- row it points at may legitimately be purged while the log outlives it.
  entity_id    uuid,
  -- PII-minimized diff (doc 15). Minimization is the writer's job; the column
  -- is granted to the tenant owner below, so a service that dumps a whole row
  -- in here publishes it to that tenant.
  before       jsonb,
  after        jsonb,
  reason       text,
  request_id   text,                                   -- correlates to the API request / log line
  ip           inet,
  user_agent   text,
  created_at   timestamptz not null default now(),

  -- amendment: doc 25 leaves `action` as bare text with the registry noted in
  -- prose ("registry in src/lib/audit/actions.ts - dot-namespaced verbs;
  -- free-text actions are lint-rejected"). Two options were on the table and
  -- the choice is deliberate.
  --
  -- A value enum (check (action in ('receipt.review_approved', ...))) is the
  -- safer-looking one and is wrong here, because of WHERE the audit write sits
  -- in a transaction. It is the LAST step of the business action it records
  -- (spec section 4 guard 6: decide the receipt, then write the audit row), so
  -- an unregistered verb does not degrade to "the action happened but was not
  -- logged" - it raises 23514 and rolls back the receipt decision, the points
  -- award and the ledger row with it. A forgotten enum migration would take
  -- down the feature, not the logging. Every future slice registering a verb
  -- would carry that hazard, and the pressure would be to write the audit row
  -- outside the transaction, which is far worse than a loose column.
  --
  -- So: constrain the SHAPE, which is stable, and leave the VOCABULARY to the
  -- code registry doc 25 already designates as its home. The dot-namespacing is
  -- the part the database actually depends on - it is what makes
  -- "action like 'receipt.%'" a meaningful query and what keeps
  -- 'receipt.review_approved' from drifting into 'approve' or
  -- 'receiptReviewApproved' one slice later. Multiple segments are permitted so
  -- a future 'fraud.cooldown.applied' style needs no migration.
  --
  -- Verbs registered as of this migration (doc 37's reviewer-action mapping):
  --   receipt.review_approved, receipt.review_rejected,
  --   fraud.cooldown_applied,  fraud.cooldown_lifted,
  --   customer.segment_changed, consumer.suspended, fraud.clawback_applied
  -- plus doc 25's examples campaign.activated / staff.role_changed and doc 26's
  -- suspension.requested. The list above is documentation; the registry in code
  -- is the enforcement, per doc 25.
  constraint audit_logs_action_shape
    check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  -- Same reasoning, weaker case: entity_type is a table name, so the lowercase
  -- identifier shape is free to assert and stops 'Receipts' / 'receipt' /
  -- 'public.receipts' variants from fragmenting the entity history index.
  constraint audit_logs_entity_type_shape
    check (entity_type ~ '^[a-z][a-z0-9_]*$'),

  -- amendment: doc 25 annotates reason as "required for admin overrides
  -- (service-enforced)". Enforce it here as well. doc 15 states it twice as a
  -- security control, not a nicety - "Admin actions on tenant data always
  -- require a recorded reason (audit row)" under Authorization, and threat
  -- model item 6 is platform admin abuse / insider risk, whose entire mitigation
  -- is "least privilege, full audit". "Service-enforced" is a promise that one
  -- forgetful caller breaks silently and permanently: the row is written, it
  -- looks complete, and the missing justification is only noticed during the
  -- investigation that needed it. A check constraint makes it structural. It is
  -- safe to state at the database layer precisely because this table is
  -- append-only: the constraint is evaluated once, at insert, and there is no
  -- update path where a later edit could trip over it.
  -- Scoped to actor_kind = 'admin' deliberately: a routine user/system/worker
  -- row (a receipt approval, a nightly sweep) has no such requirement in any
  -- doc, and demanding one would push callers into writing filler text, which
  -- devalues the field on the rows that do matter.
  constraint audit_logs_admin_reason_required
    check (
      actor_kind <> 'admin'
      or (reason is not null and btrim(reason) <> '')
    ),
  -- A whitespace-only reason satisfies "not null" and records nothing.
  constraint audit_logs_reason_not_blank
    check (reason is null or btrim(reason) <> '')
  -- NO updated_at / updated_by / deleted_at and no touch trigger: append-only.
  -- Enforced by the fences below, not by the absence of columns.
);
alter table public.audit_logs enable row level security;

-- ---------------------------------------------------------------- indexes
-- doc 25's three, one per real read pattern. Each is (key, created_at desc)
-- because every audit read is "the most recent N of ...", never an unordered
-- scan.

-- A tenant's recent actions: the owner's audit screen, and the tenant-scoped
-- half of doc 37's monitoring (adjust volume per business). Also the index the
-- P1 policy below is evaluated against - business_id is the policy's leading
-- predicate. business_id has NO foreign key (see the column), so unlike every
-- other business_id index in this schema this one exists purely for reads, not
-- to keep a cascade off a sequential scan.
create index audit_biz_idx    on public.audit_logs (business_id, created_at desc);
-- One entity's history: "show me every decision ever made on this receipt",
-- which is what the review screen renders beside the image, and what an
-- investigation of a disputed approval starts from. entity_type leads because
-- entity_id alone is unique enough in practice but not by construction - ids
-- come from different tables and nothing stops a collision.
create index audit_entity_idx on public.audit_logs (entity_type, entity_id, created_at desc);
-- An actor's actions: the insider-risk read (doc 15 threat model item 6, doc 37
-- "owner self-crediting is visible even though it never passes through this
-- pipeline"). Doubles as the FK index for actor_id per doc 20's convention,
-- actor_id being the leading column.
create index audit_actor_idx  on public.audit_logs (actor_id, created_at desc);
-- Deliberately no index on `action`: within any tenant or actor window the verb
-- is a low-selectivity filter on an already-narrow result set, and the two
-- indexes above supply that window. Add one when a query plan asks for it.

-- ---------------------------------------------------------------- policies
-- P1: the tenant OWNER reads their own tenant's rows.
--
-- Role list narrowed to owner alone, against this file's neighbours - 0017
-- settled on array['owner','manager'] for receipts, fraud_signals and
-- ai_usage_events, and a manager is precisely the person who decides the
-- receipts this table records. The narrowing is doc 01's matrix read
-- literally: the "View audit logs (own tenant)" row is the one row in the whole
-- Platform block where owner is ticked and manager is not, and that asymmetry
-- is not an oversight. The audit log is the record of what the reviewers did,
-- managers included; an audience that can read the file kept on itself is the
-- insider-risk hole doc 15 lists as threat model item 6. Owner is also the only
-- business role accountable for the tenant, which is why the matrix gives them
-- the oversight surface and no one below them.
--
-- amendment: a platform-level row (business_id null) is visible to NO tenant,
-- exactly as 0017 noted for an unmatched receipt, and here it is the intended
-- outcome rather than a hazard to design around: those rows are admin and
-- system actions (suspensions, feature-flag flips, cross-tenant fraud
-- decisions) and doc 25 assigns them to the admin audience, which this file
-- cannot serve (see the next note). They are readable through the service role
-- until it can. Unlike the receipts case there is nothing to warn callers about
-- - an audit row is written for the record, not to be worked off a queue, so a
-- row no tenant can see is not a row that gets stuck.
create policy audit_logs_owner_select on public.audit_logs
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner']));
--
-- amendment: NO admin policy, against doc 25's "RLS: select admin; select owner
-- where business_id matches". Every admin predicate in doc 12 reads the
-- platform-admin claim out of the JWT and this project's custom access token
-- hook is NOT enabled (supabase/README.md, "Manual dashboard step"), so a
-- claim-based admin policy would evaluate null for every session and silently
-- deny - a policy that looks like coverage and is not. Identical call to the one
-- 0017 made for receipts and fraud_signals, and it lands the same way: admin
-- audit surfaces read via the service role until the hook is enabled, at which
-- point the admin policies for this table land with the rest of the claim-based
-- surfaces listed in that README.
--
-- NO consumer policy. A consumer is a SUBJECT of these rows, never an audience:
-- reason, before/after and the fraud-family verbs describe exactly which
-- detector fired and what the reviewer concluded, which is the same argument
-- that keeps fraud_signals consumer-invisible in 0017.
--
-- NO write policy for ANY client audience, and no write privilege either.

-- ---------------------------------------------------------------- fence 1 of 3
-- Privilege layer. Supabase grants all privileges on new public tables to the
-- app roles by default, so with no policy AND no privilege a client write fails
-- loudly with 42501 instead of silently matching zero rows (the 0013/0017
-- pattern).
revoke insert, update, delete, truncate on public.audit_logs from anon, authenticated;
-- service_role is the WRITER - the review service, the fraud pipeline and every
-- admin action insert through it - so INSERT deliberately stays. Everything else
-- goes, and this is the revoke that carries the weight: RLS does not apply to
-- service_role at all and never sees TRUNCATE from anyone, so the privilege is
-- the only thing standing between the process that writes the audit trail and
-- the ability to rewrite what it wrote a moment ago. Same shape as 0012's
-- ledger revoke and 0017's evidence revokes.
revoke update, delete, truncate on public.audit_logs from service_role;

-- amendment: column-level read fence on the two columns doc 25 captures for the
-- SECURITY record rather than for tenant consumption. ip and user_agent are the
-- actor's network address and device fingerprint. The owner policy above is
-- row-correct but column-blind, and the actors on a tenant's rows are not only
-- that tenant's staff - a consumer-initiated audited action carries a
-- business_id too, which would hand the merchant that consumer's IP. doc 15's
-- privacy section draws the line well short of that ("businesses see consumer
-- data only for their own customers and only what the CRM needs, name, visits,
-- points"), and RA 10173 data minimization is the reason the line is there.
-- Same mechanism 0017 used on receipts, and cleaner here: there is a single
-- client audience on this table, so the intersection problem that forced 0017
-- to withhold parse_meta from staff does not arise. Nothing withheld below is
-- needed by any planned client surface; the incident-response reads that DO
-- need ip/user_agent are admin reads, and those already go through the service
-- role.
-- Note for callers: "select *" on audit_logs as authenticated raises 42501.
-- Client reads must name their columns.
revoke select on public.audit_logs from anon, authenticated;
grant select (
  id, actor_id, actor_kind, actor_role, business_id,
  action, entity_type, entity_id, before, after,
  reason, request_id, created_at
) on public.audit_logs to authenticated;

-- ---------------------------------------------------------------- fence 2 of 3
-- Row trigger. The revokes above stop every app role including service_role;
-- this stops whoever still holds the privilege - the table owner, any future
-- misgrant - and is the only layer that survives someone re-granting by
-- mistake. Corrections to an audit trail are additional rows describing the
-- correction, never edits to the original.
create or replace function private.audit_logs_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_logs is append-only (security record)';
end
$$;

create trigger audit_logs_append_only
  before update or delete on public.audit_logs
  for each row execute function private.audit_logs_append_only();

-- ---------------------------------------------------------------- fence 3 of 3
-- Statement trigger. A row-level trigger does NOT fire on TRUNCATE, so a bulk
-- wipe would walk straight past fence 2 - and a bulk wipe is the shape the
-- worst case actually takes here, because someone erasing their tracks wants
-- the whole trail gone, not one row edited. Nothing references audit_logs, so
-- no foreign key would refuse the truncate first (contrast receipts in 0017,
-- which is incidentally shielded by its children); this trigger is genuinely
-- the last line.
create or replace function private.audit_logs_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_logs cannot be truncated (security record)';
end
$$;

create trigger audit_logs_no_truncate
  before truncate on public.audit_logs
  for each statement execute function private.audit_logs_no_truncate();
