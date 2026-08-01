-- ============================================================================
-- 0033_business_activation.sql
-- The merchant lifecycle, made reachable: draft -> pending_verification ->
-- active, with an admin decision in the middle and an earning rule as the
-- precondition of going live.
--
-- WHY THIS EXISTS. `businesses.status` defaults to 'draft' (0002) and NOTHING
-- in this codebase has ever moved a row off it. The one active business on this
-- project was activated by hand, in SQL, during seeding. Meanwhile every
-- consumer-facing read filters `status='active'` - `businesses_public_select`
-- (0002), the scan chooser, /home, and /b/[slug]. Business signup is open and
-- self-serve. So the shipped behaviour was: a merchant registers, completes
-- onboarding, gets a portal that looks like it works, and is invisible to every
-- consumer forever, with nothing anywhere raising an error. This migration is
-- the missing transition and the fence around it.
--
-- Contents:
--   1. The COLUMN FENCE on public.businesses. supabase/README.md has carried
--      this as owed debt since the settings slice: "owner updates could touch
--      businesses.status / verified_at / plan". This is the slice that cannot
--      ship without it, because everything else here would be advisory
--      otherwise - an owner who can PATCH their own status does not need an
--      approval queue.
--   2. private.has_usable_base_rule - the precondition, as a predicate.
--   3. public.submit_business_for_review - the merchant's transition,
--      draft -> pending_verification, opening a business_verifications round.
--   4. public.activate_business - the admin's, pending_verification -> active,
--      which REFUSES without an earning rule.
--   5. public.reject_business_verification - the admin's other one,
--      pending_verification -> draft, with a reason the merchant reads.
--   6. Admin SELECT policies on businesses and business_verifications, and the
--      index the queue reads.
--
-- THE SECOND HOLE THIS CLOSES, and the reason the earning rule is a
-- PRECONDITION rather than a reminder. Nothing required a business to have an
-- active base points rule. `award_receipt_points` (0018) awards what the rule
-- engine computes, and with no rule that is zero;
-- src/features/receipts/server/notify.ts deliberately suppresses the consumer
-- notification on a zero-point approval, because "0 points are now in your
-- wallet" reads as a failure. Both of those decisions are individually right and
-- together they produce a merchant whose receipts are APPROVED, award NOTHING,
-- and tell the customer NOTHING. That is the core loop failing in silence. A UI
-- checklist would make it recoverable; a database precondition on the one
-- transition that exposes a business to consumers makes it unreachable.
--
-- Source docs: docs/30-modules/32-business-portal.md section 2 (the lifecycle
-- diagram this file implements literally, and section 2.2's statement that
-- pending_verification is reached from a submission that writes a
-- business_verifications row), docs/30-modules/31-admin-portal.md section 3
-- (the verification queue and its decisions) and section 11 (reason required on
-- any write touching tenant data), docs/10-architecture/15-security.md
-- (admin actions on tenant data always require a recorded reason; least
-- privilege), docs/10-architecture/12-multi-tenancy-rls.md (claims are hints,
-- tables are truth for destructive permissions), docs/20-data/21-schema-identity.md
-- (businesses, business_verifications), docs/30-modules/35-points-engine.md
-- section 2 (what a base rule has to carry to award anything).
--
-- Conventions, unchanged from this schema's neighbours: no PG enums, every
-- reference schema-qualified inside functions, set search_path = '', stable
-- P0001 message strings the service layer maps to copy, revoke/grant pairing at
-- the bottom of every function, insert-returning rather than lookup-by-name.
-- ============================================================================

-- ============================================================ 1. column fence
-- The revoke-then-grant-columns pattern from 0013 and 0021, applied to the
-- table 0021 explicitly deferred.
--
-- 0021's own closing note said why it stopped short: "Deliberately not fenced in
-- 0021 because they are staff/tenant surfaces rather than the consumer
-- self-update surface this slice made load-bearing, and `businesses.status` in
-- particular needs the verification state machine settled first." The state
-- machine is settled below, so the deferral has run out.
--
-- Postgres note, repeated from 0021 because it is the whole reason this section
-- is shaped this way: revoking a COLUMN privilege is a no-op while a
-- table-level UPDATE grant remains, so the table-level privilege must be
-- revoked first and exactly the editable columns granted back. Verified live
-- before writing this file: information_schema.column_privileges listed UPDATE
-- for `authenticated` on `status`, `verified_at`, `plan`, `plan_limits` and
-- `suspended_reason`, so an owner's session could PATCH itself to
-- status='active' through PostgREST and skip every line below.
--
-- RLS is unchanged. businesses_staff_update (0002) still decides WHICH row an
-- owner or manager may update; this decides WHICH COLUMNS. Both fences have to
-- hold. SECURITY DEFINER functions are unaffected - public.register_business
-- (0003) and the three functions in this file execute as their definer - and
-- the service role bypasses grants entirely, so every server-side writer keeps
-- working.
--
-- Allowlist derivation, from 0002's DDL plus every writer in the app:
--   * name, description, phone, email, website, socials, address_line,
--     barangay, postal_code, lat, lng, opening_hours
--                            - EDITABLE_BUSINESS_COLUMNS in
--                              src/features/businesses/settings/server/repo.ts,
--                              the one and only client write to this table
--                              today. That module's header says it exists
--                              because this fence did not; it stays as the
--                              second layer, and its own test suite asserts the
--                              same list.
--   * logo_url, cover_url,
--     gallery, city_id,
--     google_place_id,
--     business_type_id       - the rest of doc 32 section 4's store profile.
--                              No writer yet (the settings form fences them in
--                              code, and the map picker is not Google's so
--                              nothing can mint a google_place_id), but every
--                              one of them is self-descriptive merchant content
--                              whose only possible author is the merchant, on
--                              the same reasoning 0021 used to grant
--                              marketing_opt_in ahead of its writer.
--   * updated_by             - actor stamp, per the 0013 and 0021 precedent.
--                              RLS already pins the row to the caller's tenant.
--
-- Deliberately NOT granted, with the reason each one is dangerous:
--   * status            - THE defect. A self-activating merchant makes the
--                         approval queue below decorative, and an unvetted shop
--                         appearing as a legitimate Giya merchant is the
--                         consumer-trust problem the queue exists to prevent.
--   * verified_at       - the timestamp that says a human checked. Writable by
--                         the party it vouches for, it says nothing.
--   * plan, plan_limits - entitlement and billing hooks (0002 marks them
--                         [SCALE]). Self-writable is a free upgrade to
--                         enterprise.
--   * suspended_reason  - the record of why a tenant was stopped; the same
--                         class of defect as profiles.suspended_reason, which
--                         0021 fenced for consumers.
--   * slug              - the tenant's public identity token and the key in
--                         every printed QR link. doc 32 section 4 makes it
--                         owner-only and once per 30 days after activation,
--                         which is a rule no column grant can express; granting
--                         the column without its enforcement path defeats it,
--                         exactly as 0021 argued for the birth_date pair.
--                         Nothing writes it today, so nothing breaks.
--   * id                - the PK and the tenancy key of every policy on this
--                         table.
--   * created_at, created_by, updated_at, deleted_at - audit columns;
--                         updated_at is maintained by the touch_businesses
--                         trigger, which is a trigger write and therefore not
--                         subject to these column grants. deleted_at is a soft
--                         delete: tenant closure is a deliberate flow with
--                         data-retention consequences, not a PATCH.
--   * search_tsv        - generated always; not writable by anyone.
--
-- Note for callers: an UPDATE naming any column above raises 42501 for an
-- `authenticated` session, including an owner's.
revoke update on public.businesses from anon, authenticated;
grant update (
  name,
  description,
  logo_url,
  cover_url,
  gallery,
  phone,
  email,
  website,
  socials,
  address_line,
  barangay,
  city_id,
  postal_code,
  lat,
  lng,
  google_place_id,
  opening_hours,
  business_type_id,
  updated_by
) on public.businesses to authenticated;

-- ============================================================ 2. precondition
-- "Has an active base earning rule that can actually award points."
--
-- Not merely "a row exists". points_rules (0012) constrains
-- rate_centavos_per_point > 0 and fixed_points > 0 WHEN PRESENT, but it does not
-- require the column its own rule_type reads - an amount_rate row with a null
-- rate satisfies every constraint on the table and awards nothing, and
-- src/features/points/compute.ts throws on exactly that shape. So the predicate
-- below mirrors computeBasePoints case for case: whatever that function needs
-- in order to return a number is what this function requires to be present.
-- Anything looser would let the silent-zero failure back in through a
-- half-filled rule, which is the more likely accident than no rule at all.
--
-- points_rules_one_base (0012) already guarantees at most one active base rule
-- per business, so `exists` is the whole question.
--
-- `stable`, language sql, so the planner inlines it. Not SECURITY DEFINER: its
-- only callers are the three definer functions below, which already run as the
-- definer, and execute is revoked from every role so it is not a surface.
create or replace function private.has_usable_base_rule(p_business_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.points_rules pr
     where pr.business_id = p_business_id
       and pr.kind = 'base'
       and pr.is_active = true
       and pr.deleted_at is null
       and (
            (pr.rule_type = 'amount_rate' and pr.rate_centavos_per_point is not null)
         or (pr.rule_type in ('fixed_per_visit', 'fixed_per_receipt')
             and pr.fixed_points is not null)
         or (pr.rule_type = 'tiered_amount'
             and pr.tiers is not null
             and jsonb_typeof(pr.tiers) = 'array'
             and jsonb_array_length(pr.tiers) > 0)
       )
  );
$$;

revoke execute on function private.has_usable_base_rule(uuid)
  from public, anon, authenticated, service_role;

-- ============================================================ 3. submit
-- doc 32 section 2: "checklist -> submit docs -> status='pending_verification'
-- (verification round)".
--
-- WHY THIS IS AN RPC AT ALL. Section 1 above just revoked UPDATE on
-- `businesses.status` from every client role, which is what makes the approval
-- queue real - and it takes the merchant's own transition with it. That is not
-- collateral damage, it is the design: the merchant does not SET a status, they
-- REQUEST a review, and the two differ in that a request has preconditions. A
-- server action holding the service-role key could write the column directly,
-- but then the precondition, the round row and the audit row would be three
-- PostgREST statements that can each fail alone, and the failure mode is a
-- business sitting at pending_verification with no round for an admin to
-- decide. One function, one transaction.
--
-- WHAT IT DELIBERATELY DOES NOT DO, so the omissions are decisions:
--   * no documents. doc 32 section 2.2 describes uploads to
--     business_documents with a doc_type picker and TIN encryption; none of
--     that exists (the onboarding wizard holds picked files in React state and
--     uploads nothing, which is why
--     src/components/business/verification-banner.tsx was corrected to stop
--     claiming documents were under review). This function opens a round with
--     no documents attached and the merchant-facing copy says so. Adding
--     documents later attaches them to the same round row and changes nothing
--     here.
--   * no TIN, no registered_name, no registration_type. Same reason. All three
--     are nullable in 0002 precisely because a round can be opened before they
--     are collected.
--   * no notification. doc 33's copy matrix has no merchant-facing kind for
--     this, and inventing one is a different slice's decision.
create or replace function public.submit_business_for_review(
  p_business_id uuid,
  p_actor_id    uuid,
  p_note        text default null,
  p_request_id  text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business record;
  v_role     text;
  v_note     text;
  v_round_id uuid;
begin
  -- Step 1: inputs.
  if p_business_id is null or p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'SUBMIT_INPUT_INVALID';
  end if;
  -- The applicant note is optional (0002 calls it "applicant notes"), but a
  -- whitespace-only one is stored as null rather than as a blank string that
  -- renders as an empty paragraph on the admin's decision screen.
  v_note := nullif(btrim(coalesce(p_note, '')), '');

  -- Step 2: the actor is this tenant's ACTIVE OWNER, by table truth.
  --
  -- Owner alone, per doc 32 section 2.2 ("owner only (matrix)") and doc 01's
  -- permission matrix. A manager runs the shop; committing the business to a
  -- platform review under the owner's name is not a shop operation.
  --
  -- Read from business_staff rather than through private.is_staff_of, for the
  -- same reason clawback_receipt_points (0031) reads platform_admins directly:
  -- the claim helpers answer for auth.uid(), and this function is service-role
  -- only, so there is no session claim to answer from. The actor arrives as a
  -- parameter and is verified here rather than trusted.
  select bs.role into v_role
    from public.business_staff bs
   where bs.business_id = p_business_id
     and bs.user_id = p_actor_id
     and bs.status = 'active';
  if v_role is distinct from 'owner' then
    raise exception using errcode = 'P0001', message = 'SUBMIT_FORBIDDEN';
  end if;

  -- Step 3: load and lock the business. The lock serializes a double submit
  -- (two tabs, one impatient owner) into one round rather than two.
  select b.id, b.status, b.name, b.deleted_at
    into v_business
    from public.businesses b
   where b.id = p_business_id
     for update;
  if not found or v_business.deleted_at is not null then
    raise exception using errcode = 'P0001', message = 'BUSINESS_NOT_FOUND';
  end if;

  -- Step 4: state. Only a draft may be submitted.
  --
  -- 'pending_verification' is refused rather than treated as idempotent: an
  -- owner pressing submit twice must be told their review is already open, not
  -- silently given a second round that splits the admin's queue into two rows
  -- for one shop. 'active' and 'suspended' are refused because neither is a
  -- state a review round means anything in - a suspended tenant is reinstated
  -- through the admin surface that suspended it, not by reapplying, and that
  -- path is a separate slice (see the note at the bottom of this file).
  if v_business.status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'SUBMIT_INVALID_STATE';
  end if;

  -- Step 5: THE PRECONDITION, checked here as well as in activate_business.
  --
  -- The authoritative check is the one in activate_business - that is the
  -- transition that exposes a business to consumers, and a rule deleted between
  -- submission and approval has to be caught there or the guarantee is only a
  -- guarantee about the past. This one exists so the merchant learns it now,
  -- from their own screen, instead of days later from a rejection.
  if not private.has_usable_base_rule(p_business_id) then
    raise exception using errcode = 'P0001', message = 'ACTIVATION_NO_EARNING_RULE';
  end if;

  -- Step 6: the round. doc 32 section 2.2: the submission "creates
  -- business_verifications (status='pending' ...)" and section 2 makes the
  -- existence of that row the thing that distinguishes pending_verification
  -- from a status somebody typed.
  insert into public.business_verifications
    (business_id, status, notes, created_by, updated_by)
  values
    (p_business_id, 'pending', v_note, p_actor_id, p_actor_id)
  returning id into v_round_id;

  -- Step 7: the status.
  update public.businesses b
     set status     = 'pending_verification',
         updated_by = p_actor_id
   where b.id = p_business_id;

  -- Step 8: the audit row, in the same transaction.
  --
  -- actor_kind='user', not 'admin': this is the merchant acting on their own
  -- tenant. That matters at the database layer, because
  -- audit_logs_admin_reason_required (0022) makes `reason` mandatory only for
  -- actor_kind='admin', and demanding a justification from a merchant for
  -- asking to be reviewed would produce filler text on every row. The optional
  -- applicant note goes in `reason` when there is one, which is what
  -- audit_logs_reason_not_blank means by refusing a blank one.
  --
  -- business_id is set, so this row is readable by the tenant's own owner
  -- through audit_logs_owner_select (0022) as well as by an admin (0031).
  insert into public.audit_logs
    (actor_id, actor_kind, actor_role, business_id, action,
     entity_type, entity_id, before, after, reason, request_id)
  values
    (p_actor_id, 'user', v_role, p_business_id,
     'business.review_submitted', 'business', p_business_id,
     jsonb_build_object('status', v_business.status),
     jsonb_build_object('status', 'pending_verification', 'verification_id', v_round_id),
     v_note, p_request_id);

  return jsonb_build_object(
    'business_id',     p_business_id,
    'status',          'pending_verification',
    'verification_id', v_round_id
  );
end
$$;

revoke execute on function public.submit_business_for_review(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_business_for_review(uuid, uuid, text, text)
  to service_role;

-- ============================================================ 4. activate
-- doc 32 section 2: "admin decision (31 section 3) -> approved -> status='active',
-- verified_at set".
--
-- THIS IS THE FUNCTION THE WHOLE MIGRATION IS FOR. It is the only path from any
-- status to 'active' that exists on this database, and it holds three things
-- that cannot be held anywhere else:
--
--   1. The earning-rule precondition, evaluated INSIDE the transaction that
--      flips the status, under the business row lock. A check in TypeScript
--      before a separate write is a race against the owner deleting their rule
--      in the next tab; a check in the UI is advice.
--   2. The admin's authority, by table truth (doc 12: claims refresh at most
--      hourly, revocation must be immediate, so destructive-permission checks
--      verify against the table server-side). An admin deactivated ten minutes
--      ago still carries a valid claim.
--   3. The audit row, in the same transaction, with a mandatory reason. An
--      activation nobody can account for is exactly the insider-risk case doc
--      15 lists as threat-model item 6.
--
-- Lock order: businesses -> business_verifications. Identical in the two admin
-- functions below and in submit above, so a submission and a decision on the
-- same tenant serialize on the business row and can never interleave.
create or replace function public.activate_business(
  p_business_id uuid,
  p_actor_id    uuid,
  p_reason      text,
  p_request_id  text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business    record;
  v_reason      text;
  v_admin_role  text;
  v_round_id    uuid;
  v_verified_at timestamptz;
begin
  -- Step 1: the reason, first and separately, exactly as
  -- clawback_receipt_points (0031) does it and for the same reason: doc 15
  -- states it twice as a security control and doc 31 section 11 makes it the
  -- pattern for any write touching tenant data.
  -- audit_logs_admin_reason_required would catch a blank one at the very end of
  -- this function anyway; catching it here means the caller gets
  -- ACTIVATION_REASON_REQUIRED instead of a 23514 raised after the status was
  -- already written and rolled back.
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception using errcode = 'P0001', message = 'ACTIVATION_REASON_REQUIRED';
  end if;
  if p_business_id is null or p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'ACTIVATION_INPUT_INVALID';
  end if;

  -- Step 2: the actor is an ACTIVE platform admin, by table truth, and not
  -- `support` - doc 01's matrix makes support read-only everywhere.
  select pa.role into v_admin_role
    from public.platform_admins pa
   where pa.user_id = p_actor_id and pa.is_active = true;
  if v_admin_role is null or v_admin_role = 'support' then
    raise exception using errcode = 'P0001', message = 'ACTIVATION_FORBIDDEN';
  end if;

  -- Step 3: load and lock the business.
  select b.id, b.status, b.name, b.verified_at, b.deleted_at
    into v_business
    from public.businesses b
   where b.id = p_business_id
     for update;
  if not found or v_business.deleted_at is not null then
    raise exception using errcode = 'P0001', message = 'BUSINESS_NOT_FOUND';
  end if;

  -- Step 4: state. Only a tenant that ASKED may be approved.
  --
  -- A draft is refused deliberately, even though an admin could reasonably want
  -- to fast-track one: activating a business that never submitted means there
  -- is no round to record the decision against and no merchant statement to
  -- have reviewed, so the audit trail would say a human approved something
  -- nobody applied for. The route for that case is to ask the owner to submit.
  if v_business.status <> 'pending_verification' then
    raise exception using errcode = 'P0001', message = 'ACTIVATION_INVALID_STATE';
  end if;

  -- Step 5: THE PRECONDITION. Re-checked here, under the row lock, because
  -- submission may have been days ago and points_rules is freely editable by
  -- the owner throughout.
  --
  -- This is the check that makes the silent-zero failure impossible rather than
  -- merely recoverable: with no usable base rule, every receipt this business
  -- ever approved would award zero points, and notify.ts suppresses the
  -- consumer notification on a zero award, so neither party would be told
  -- anything. A business in that state must not become visible to consumers,
  -- and this is the only door.
  if not private.has_usable_base_rule(p_business_id) then
    raise exception using errcode = 'P0001', message = 'ACTIVATION_NO_EARNING_RULE';
  end if;

  v_verified_at := now();

  -- Step 6: the round. Updated rather than required: a row hand-moved to
  -- pending_verification (as the seed did for the demo tenant) has no open
  -- round, and refusing to approve it would make this function unable to
  -- resolve exactly the states that predate it. Null v_round_id is reported in
  -- the return value rather than hidden.
  update public.business_verifications bv
     set status          = 'approved',
         decision_reason = v_reason,
         decided_by      = p_actor_id,
         decided_at      = v_verified_at,
         updated_by      = p_actor_id
   where bv.id = (
     select bv2.id
       from public.business_verifications bv2
      where bv2.business_id = p_business_id
        and bv2.status = 'pending'
      order by bv2.created_at desc
      limit 1
   )
  returning bv.id into v_round_id;

  -- Step 7: the status and the timestamp that says a human checked.
  update public.businesses b
     set status      = 'active',
         verified_at = v_verified_at,
         updated_by  = p_actor_id
   where b.id = p_business_id;

  -- Step 8: the audit row, INSIDE the transaction. actor_kind='admin' is what
  -- makes the reason mandatory at the database layer; step 1 is the same check
  -- moved early enough to produce a useful error.
  insert into public.audit_logs
    (actor_id, actor_kind, actor_role, business_id, action,
     entity_type, entity_id, before, after, reason, request_id)
  values
    (p_actor_id, 'admin', v_admin_role, p_business_id,
     'business.activated', 'business', p_business_id,
     jsonb_build_object('status', v_business.status, 'verified_at', v_business.verified_at),
     jsonb_build_object('status', 'active', 'verified_at', v_verified_at,
                        'verification_id', v_round_id),
     v_reason, p_request_id);

  return jsonb_build_object(
    'business_id',     p_business_id,
    'status',          'active',
    'verified_at',     v_verified_at,
    'verification_id', v_round_id
  );
end
$$;

revoke execute on function public.activate_business(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.activate_business(uuid, uuid, text, text)
  to service_role;

-- ============================================================ 5. reject
-- doc 32 section 2: "revision_requested/rejected -> fix docs, resubmit (new
-- round)".
--
-- Sends the tenant back to 'draft', which is the state everything in the portal
-- is already editable from, and records the reason on the ROUND rather than
-- only in audit_logs. That split is deliberate and it is the opposite of the
-- call clawback_receipt_points made:
--
--   * a clawback's reason may name another consumer or another tenant's
--     receipt, so 0031 keeps it out of any merchant-readable column;
--   * a verification rejection's reason IS the merchant-facing message. doc 32
--     section 2.2 requires the status panel to show the admin's decision_reason
--     "verbatim" with a "Fix and resubmit" affordance. A merchant told only
--     "rejected" has no route back, which turns the queue into the same dead end
--     this migration exists to remove.
--
-- business_verifications.decision_reason is readable by the tenant's owner and
-- manager through business_verifications_staff_select (0002), so writing it
-- there is what makes the rejection legible to them. The admin surface says so
-- on the input.
--
-- One text, written twice (round + audit row), on the same argument
-- suspendConsumer uses for suspended_reason: two fields that are supposed to
-- agree cannot disagree if they come from one string.
--
-- doc 32 also lists 'revision_requested' as a distinct outcome. It is not
-- implemented here and the reason is that the two differ only by whether
-- documents already on file are kept - and there are no documents yet. When
-- uploads land, revision_requested becomes a third function or a parameter;
-- shipping it now would be a status a merchant can reach and nothing can
-- distinguish.
create or replace function public.reject_business_verification(
  p_business_id uuid,
  p_actor_id    uuid,
  p_reason      text,
  p_request_id  text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business   record;
  v_reason     text;
  v_admin_role text;
  v_round_id   uuid;
begin
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception using errcode = 'P0001', message = 'REJECTION_REASON_REQUIRED';
  end if;
  if p_business_id is null or p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'REJECTION_INPUT_INVALID';
  end if;

  select pa.role into v_admin_role
    from public.platform_admins pa
   where pa.user_id = p_actor_id and pa.is_active = true;
  if v_admin_role is null or v_admin_role = 'support' then
    raise exception using errcode = 'P0001', message = 'REJECTION_FORBIDDEN';
  end if;

  select b.id, b.status, b.name, b.deleted_at
    into v_business
    from public.businesses b
   where b.id = p_business_id
     for update;
  if not found or v_business.deleted_at is not null then
    raise exception using errcode = 'P0001', message = 'BUSINESS_NOT_FOUND';
  end if;

  if v_business.status <> 'pending_verification' then
    raise exception using errcode = 'P0001', message = 'REJECTION_INVALID_STATE';
  end if;

  update public.business_verifications bv
     set status          = 'rejected',
         decision_reason = v_reason,
         decided_by      = p_actor_id,
         decided_at      = now(),
         updated_by      = p_actor_id
   where bv.id = (
     select bv2.id
       from public.business_verifications bv2
      where bv2.business_id = p_business_id
        and bv2.status = 'pending'
      order by bv2.created_at desc
      limit 1
   )
  returning bv.id into v_round_id;

  -- Back to 'draft', not to a new status. doc 32 section 2.3 lists everything
  -- editable pre-verification and it is the whole portal; 'draft' already means
  -- exactly that, and a 'rejected' business status would be a fifth state whose
  -- only difference from draft is a sentence the round row already carries.
  -- verified_at is deliberately left alone: it is null for a tenant that has
  -- never been approved, and a tenant that WAS approved cannot reach this
  -- function (step above refuses anything but pending_verification).
  update public.businesses b
     set status     = 'draft',
         updated_by = p_actor_id
   where b.id = p_business_id;

  insert into public.audit_logs
    (actor_id, actor_kind, actor_role, business_id, action,
     entity_type, entity_id, before, after, reason, request_id)
  values
    (p_actor_id, 'admin', v_admin_role, p_business_id,
     'business.verification_rejected', 'business', p_business_id,
     jsonb_build_object('status', v_business.status),
     jsonb_build_object('status', 'draft', 'verification_id', v_round_id),
     v_reason, p_request_id);

  return jsonb_build_object(
    'business_id',     p_business_id,
    'status',          'draft',
    'verification_id', v_round_id
  );
end
$$;

revoke execute on function public.reject_business_verification(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.reject_business_verification(uuid, uuid, text, text)
  to service_role;

-- ============================================================ 6. the queue
-- ------------------------------------------------------------ index
-- The admin queue's exact read: pending tenants, oldest first, because the
-- oldest applicant is the one whose patience is running out. Partial on the
-- status this file introduced traffic to, so it stays a handful of pages
-- forever rather than growing with the platform.
--
-- businesses_status_idx (0002) would answer it, but only by scanning every
-- status's rows for the one value the queue cares about and then sorting; this
-- one is already in the order the screen renders.
create index businesses_pending_review_idx
  on public.businesses (created_at)
  where status = 'pending_verification' and deleted_at is null;

-- ------------------------------------------------------------ admin policies
-- The 0031 pattern, for the two tables this slice's admin surface reads.
--
-- Both are genuinely unreadable by an admin today, which is a sharper gap than
-- the ones 0031 closed. businesses_public_select (0002) is scoped to
-- `status='active'` and businesses_staff_select to membership, so a platform
-- admin has NO policy that matches a business awaiting review - the exact rows
-- their queue is made of. business_verifications is staff-only for the same
-- kind of reason. The queue itself reads through the service role (which is why
-- it works at all), and these policies are what make a direct client read - a
-- future admin API route, a client-side lookup - correct rather than silently
-- empty.
--
-- SELECT only. Every write in this domain goes through the three functions
-- above, which is the point of them: a policy that let an admin's session
-- UPDATE businesses.status directly would reintroduce the hole section 1 just
-- closed, one role over.
create policy businesses_admin_select on public.businesses
  for select to authenticated
  using (private.is_admin());

create policy business_verifications_admin_select on public.business_verifications
  for select to authenticated
  using (private.is_admin());

-- No admin policy on business_staff, deliberately, though the queue does show
-- the applicant's name: doc 21 assigns that roster to the tenant, the admin
-- surface reads it through the service role with only display_name and email
-- selected, and widening a roster containing invite_token to another audience
-- is the change supabase/README.md already flags as owed a column fence first.

-- ============================================================ what is NOT here
-- Stated so the gaps are decisions rather than discoveries:
--   * No transition out of 'suspended'. Tenant suspension has no writer at all
--     yet (doc 37's ladder suspends CONSUMERS; the tenant-level equivalent is
--     doc 31 section 4.2 and unbuilt), so a reinstatement path would be the
--     second half of a mechanism whose first half does not exist.
--   * No 'closed' transition. Tenant closure is a data-retention flow, not a
--     status write.
--   * No document upload, no TIN capture, no 'revision_requested'. See the
--     notes on functions 3 and 5.
--   * No de-activation. An active business that must stop trading is a
--     suspension, which is the bullet above.
-- ============================================================================
