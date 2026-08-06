-- ============================================================================
-- 0052_definer_service_role_hygiene.sql
-- Controller sweep following task 1.4's M6 finding.
--
-- WHAT M6 FOUND. `cancel_claim` shipped in 0050 with a `revoke execute ...
-- from public, anon` and was nonetheless EXECUTABLE BY service_role. The
-- assumption that revoking from `public` transitively covers `service_role`
-- is false on Supabase: the project grants EXECUTE on new `public`-schema
-- functions to `service_role` through PROJECT-LEVEL DEFAULT PRIVILEGES
-- (`alter default privileges`), which apply at CREATE time and are entirely
-- independent of anything the migration revokes. 0051 closed it for
-- `cancel_claim` with an explicit `revoke ... from service_role`.
--
-- WHY THIS FILE EXISTS. That finding generalizes, so all 25 SECURITY DEFINER
-- functions were swept live. Three more carry a `service_role` EXECUTE grant
-- they never needed:
--
--   public.claim_reward(uuid)
--   public.validate_redemption(uuid, text, text)
--   public.register_business(text, text, text, text)
--
-- All three are invoked with the CALLER'S SESSION - a consumer claiming, a
-- staff member validating at the counter, a new owner registering - and never
-- with the service key. Nothing in `src/` calls them through
-- `createServiceRoleClient`.
--
-- IS THIS A VULNERABILITY? No. `service_role` is our own server-side identity
-- and it is already trusted. This is defense in depth, and it is the specific
-- depth this schema is built on: the three-layer fence (RLS + privilege
-- revokes + raising triggers) exists so that even the service role cannot
-- write the ledger outside the intended RPCs. `claim_reward` and
-- `validate_redemption` ARE ledger writers. Leaving them service-role
-- reachable means a leaked service key can mint a redemption and burn a
-- consumer's points without ever touching a table directly - which is exactly
-- the path the fence was designed to close.
--
-- `register_business` is not a money path, but it writes `businesses` +
-- `business_staff` and stamps ownership; the same reasoning applies at lower
-- stakes, and consistency is worth more than a case-by-case judgment here.
--
-- ALSO: public.rls_auto_enable(). This is the ONLY definer function in the
-- schema executable by `anon`, via the default PUBLIC grant it was created
-- with. Assessed and deliberately treated as hygiene rather than an incident:
-- it is the body of the pre-existing `ensure_rls` event trigger, its first
-- statement is `pg_event_trigger_ddl_commands()` which raises outside an
-- event-trigger context, and it returns pseudo-type `event_trigger` which
-- PostgREST cannot marshal - so it is not callable as an RPC in practice.
-- Revoked anyway: "not exploitable today" is a weaker property than "not
-- granted", and this one costs nothing. The event trigger itself is
-- unaffected - event triggers execute as the trigger owner and do not
-- consult EXECUTE privilege on their function.
--
-- NOT CHANGED, deliberately: every function a background job or server-side
-- worker genuinely calls with the service key keeps its grant -
-- award_receipt_points, record_receipt_visit, clawback_receipt_points,
-- expire_claims, expire_points, points_expiry_warn, sweep_stuck_receipts,
-- sweep_job_health, the campaign attribution helpers, the business
-- verification RPCs, receipt_routing_breakdown, points_next_expiry,
-- points_expirable_remainder, fixed_per_visit_already_paid.
--
-- Source: supabase/migrations/0051_cancel_claim_review_fixes.sql (the M6 fix
-- this generalizes), docs/10-architecture/15-security.md, and the fence
-- rationale in supabase/README.md.
-- ============================================================================

revoke execute on function public.claim_reward(uuid) from service_role;

revoke execute on function public.validate_redemption(uuid, text, text)
  from service_role;

revoke execute on function public.register_business(text, text, text, text)
  from service_role;

revoke execute on function public.rls_auto_enable() from public, anon, authenticated, service_role;
