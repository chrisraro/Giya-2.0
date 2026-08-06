import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/lib/supabase/types";

import type { BusinessRole } from "../../server/resolve-owner-business";
import { canActOnRole, ROLE_CHANGE_ROLES } from "../roles";
import type { ChangeRoleInput, InviteInput } from "../schemas";
import type { ActionResult, StaffRosterItem, StaffStatus } from "../types";
import { STAFF_AUDIT_ACTIONS, writeStaffAuditRow } from "./audit";
import { sendStaffInviteEmail } from "./notify";
import { generateInviteToken, inviteExpiresAt } from "./token";

// ===========================================================================
// business_staff writes: invite, revoke, accept, role-change.
// ===========================================================================
//
// WHY EVERY WRITE HERE GOES THROUGH A SERVICE-ROLE CLIENT, NOT THE SESSION
// ---------------------------------------------------------------------------
// `business_staff` (0002) ships with exactly ONE client policy:
// `business_staff_tenant_select`. There is no insert, update or delete policy
// for `authenticated` at all - the migration's own comment says so ("writes
// service-role only for now (invites/role changes ship with the staff
// module)"). This is unlike every neighbouring feature this module was
// modelled on: `business_customers` (customers/server/repo.ts) and
// `businesses` (settings/server/repo.ts) both DO have an owner/manager UPDATE
// policy, so those slices write through the caller's own session and RLS is
// the real fence. Here RLS grants a caller nothing to write with, so the role
// gate applied BEFORE `createServiceRoleClient()` below (`STAFF_ROSTER_ROLES`
// in actions.ts, plus `canActOnRole` in this file for the finer per-target-role
// rule) is not a second layer behind RLS - it is the ONLY server-side fence.
// A missing service-role key is therefore NOT the "best effort, log and
// continue" degraded path customers/server/audit.ts documents for ITS
// service-role use (which is audit-only, alongside a session-writable row):
// here it means the write literally cannot happen, so it is reported as a
// clean, unavailable-dependency failure - same shape as
// `src/features/admin/jobs.ts`'s `DEPENDENCY_UNAVAILABLE`.
//
// WHY WRITE-THEN-AUDIT-ELSE-REVERT, NOT CAMPAIGNS'/CUSTOMERS' BEST EFFORT
// ---------------------------------------------------------------------------
// `campaigns/server/service.ts` and `customers/server/service.ts` both write
// first and treat a failed audit insert as "report ok:false, do NOT revert" -
// their own headers argue that reverting a campaign status or a customer
// segment can contradict something ELSE that already read the new value
// mid-request, and that the revert itself would race the very write it is
// undoing. Neither argument holds here, and one new one cuts the other way:
//   (a) nothing else in this codebase reads `business_staff` mid-request the
//       way `receipts/server/award.ts` reads a campaign's live status - the
//       one reader that matters, the custom access token hook (0003), only
//       ever runs at token ISSUANCE, never mid-request.
//   (b) `business_staff` rows are exactly the thing `admin/jobs.ts`'s header
//       calls "unrecoverable" territory: a role or membership change IS an
//       access-control decision, not a business-data edit, and doc 15's
//       insider-abuse threat model (item 6) is precisely "who has access to
///      the tenant, and is that recorded" - the campaigns/customers argument
//       ("this is business data, an audit gap costs a log line, not a
//       privilege") does not apply to a table whose entire job is to say who
//       may act as staff.
// So: this module follows `admin/jobs.ts`'s shape (write, attempt delivery /
// the row's own side effects, audit LAST, and on an audit failure UNDO the
// write) rather than campaigns'/customers' best-effort - see each function's
// own `revert*` helper.
// ===========================================================================

const UNAVAILABLE: ActionResult<never> = {
  ok: false,
  message: "This action is not available right now. Try again shortly.",
};

function mapRow(row: BusinessStaffRow): StaffRosterItem {
  return {
    id: row.id,
    role: row.role as BusinessRole,
    status: row.status as StaffStatus,
    invitedEmail: row.invited_email,
    createdAt: row.created_at,
  };
}

interface BusinessStaffRow {
  id: string;
  business_id: string;
  user_id: string;
  role: string;
  status: string;
  invited_email: string | null;
  invite_token: string | null;
  invite_expires_at: string | null;
  created_at: string;
}

const ROSTER_COLUMNS =
  "id, business_id, user_id, role, status, invited_email, invite_token, invite_expires_at, created_at";

/**
 * The roster read. Unlike every write below, this DOES go through the
 * caller's own session: `business_staff_tenant_select` (0002/0011) grants
 * read to any active member of the tenant, so RLS is a real fence here and a
 * service-role client would only widen what a caller could accidentally see.
 */
export async function loadRoster(businessId: string): Promise<ActionResult<StaffRosterItem[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("business_staff")
    .select(ROSTER_COLUMNS)
    .eq("business_id", businessId)
    .order("created_at", { ascending: true });

  if (error !== null) {
    console.error("[businesses/staff] roster read failed", error);
    return { ok: false, message: "Could not load the staff roster." };
  }

  return { ok: true, data: (data ?? []).map((row) => mapRow(row as BusinessStaffRow)) };
}

export interface StaffActor {
  userId: string;
  role: BusinessRole;
}

export interface ResolvedInvitee {
  ok: true;
  userId: string;
  /** Set only when this call minted a brand-new, unconfirmed account - see
   * notify.ts's `StaffInviteEmailInput.newAccountSetupLink`. */
  actionLink: string | null;
}

export type ResolveInviteeResult = ResolvedInvitee | { ok: false; message: string };

/**
 * Resolves the auth user id an invite's `business_staff.user_id` should
 * point at, minting a brand-new (unconfirmed) account when the email has none
 * yet. `user_id` is NOT NULL with no default (0002) and there is no
 * "pending invite, no account" table anywhere in this schema, so this is the
 * ONLY point in the flow where that constraint could otherwise fail: without
 * it, inviting someone who has never signed up simply could not insert a row
 * at all, which is exactly the "no account" path doc 30 section 2.7 requires
 * ("No account -> registration form pre-filled with invited_email -> same
 * flip post-verification").
 *
 * DECISION (brief: "you should not need a migration" - this is how): uses
 * `auth.admin.generateLink({type: "invite", ...})` rather than
 * `admin.createUser` or `admin.inviteUserByEmail`. `generateLink` is
 * documented to "handle... the creation of the user for signup, invite and
 * magiclink" AND to send no email of its own (unlike `inviteUserByEmail`,
 * which fires Supabase's own templated mail) - this app owns 100% of the
 * invitee-facing copy and link (our own `/invite/[token]`, not Supabase's
 * confirm URL), so a second, competing "invite" email from Supabase's default
 * template would be actively confusing.
 *
 * WHAT THIS DOES NOT SOLVE, ON PURPOSE: resolving an email that ALREADY has a
 * Giya account to that SAME existing id relies entirely on `generateLink`'s
 * own server-side behaviour for an existing user, which this module cannot
 * observe without a live project (supabase-js's admin API has no
 * list-users-by-email filter to verify against independently - see this
 * function's test file for the injected-dependency seam this uncertainty is
 * pushed behind). Any failure - already registered and confirmed, rate
 * limited, malformed address - surfaces as a plain, honest `{ok: false}` with
 * the provider's own message, never a crash and never a silently-wrong id.
 *
 * ===========================================================================
 * FLAGGED, UNRESOLVED (review C2): SELF-SERVE MINTING OF THIRD-PARTY ACCOUNTS
 * ===========================================================================
 * This function calls `auth.admin.createUser`-adjacent machinery
 * (`generateLink` creates the account when none exists) on an email address
 * supplied by the INVITING business, with no verification that address
 * belongs to who the inviter says it does. Business registration
 * (`register_business`, 0003) is self-serve with no approval gate. So: any
 * self-registered business, through this one text field, can cause Giya to
 * create a real `auth.users` row - and, via `handle_new_user`'s trigger
 * (0003), a `profiles` row AND a `consumers` row - for an arbitrary
 * third-party address that never asked for a Giya account, never signed up,
 * and never consented to being profiled as a consumer. There is no rate
 * limit on invites in this module, and REVOKING an invite (`revokeInvite`)
 * does NOT delete or otherwise clean up the auth account it minted - the
 * shadow account persists indefinitely even for a revoked, never-accepted
 * invite.
 *
 * This is a genuine doc 15 (PII / consent) question, not a coding bug this
 * function can fix unilaterally: is minting an unconfirmed account on
 * someone else's say-so an acceptable trade for letting a legitimate "no
 * account yet" invite work at all (the brief's required behavior #2), or
 * does it need a rate limit, an approval step, a cleanup-on-revoke path, or
 * an architectural change (resolve `user_id` at ACCEPT time against a
 * nullable column instead, which needs a migration this task was told to
 * avoid)? RECORDED HERE, per review instruction, rather than decided
 * unilaterally - this needs product/security sign-off before this path sees
 * real traffic, not a default this function quietly picked.
 */
async function defaultResolveInvitee(
  supabase: SupabaseClient<Database>,
  email: string,
): Promise<ResolveInviteeResult> {
  const { data, error } = await supabase.auth.admin.generateLink({ type: "invite", email });
  if (error !== null || data.user === null) {
    return { ok: false, message: error?.message ?? "Could not prepare this invite." };
  }
  return { ok: true, userId: data.user.id, actionLink: data.properties?.action_link ?? null };
}

export interface StaffServiceDeps {
  resolveInvitee: typeof defaultResolveInvitee;
  sendInviteEmail: typeof sendStaffInviteEmail;
  now: () => Date;
}

export function defaultDeps(): StaffServiceDeps {
  return {
    resolveInvitee: defaultResolveInvitee,
    sendInviteEmail: sendStaffInviteEmail,
    now: () => new Date(),
  };
}

const UNIQUE_VIOLATION = "23505";

export interface Business {
  id: string;
  name: string;
}

/**
 * Invites a teammate by email + role.
 *
 * GUARD ORDER: role-may-invite-this-target-role (`canActOnRole`) -> service
 * role available -> resolve/create the invitee's account -> insert (CAS via
 * the table's own `unique(business_id, user_id)`, mapped to INVITE_DUPLICATE
 * on conflict) -> audit, revert the insert on audit failure -> best-effort
 * email.
 */
export async function inviteStaff(
  business: Business,
  actor: StaffActor,
  input: InviteInput,
  deps: StaffServiceDeps = defaultDeps(),
): Promise<ActionResult<StaffRosterItem>> {
  if (!canActOnRole(actor.role, input.role)) {
    return {
      ok: false,
      code: "NOT_ALLOWED",
      message:
        input.role === "owner"
          ? "Ownership cannot be granted by invite. Transfer ownership from settings instead."
          : actor.role === "manager"
            ? "A manager can only invite a staff member."
            : "You cannot invite that role.",
    };
  }

  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error("[businesses/staff] no service-role key: invite could not be written");
    return UNAVAILABLE;
  }

  const resolved = await deps.resolveInvitee(supabase, input.email);
  if (!resolved.ok) return { ok: false, message: resolved.message };

  const token = generateInviteToken();
  const expiresAt = inviteExpiresAt(deps.now());

  const { data: inserted, error: insertError } = await supabase
    .from("business_staff")
    .insert({
      business_id: business.id,
      user_id: resolved.userId,
      role: input.role,
      status: "invited",
      invited_email: input.email,
      invite_token: token,
      invite_expires_at: expiresAt,
      created_by: actor.userId,
      updated_by: actor.userId,
    })
    .select(ROSTER_COLUMNS)
    .single<BusinessStaffRow>();

  if (insertError !== null) {
    if (insertError.code !== UNIQUE_VIOLATION) {
      console.error("[businesses/staff] invite insert failed", insertError);
      return { ok: false, message: "Could not send this invite. Try again." };
    }
    // 23505 on `unique(business_id, user_id)` (0002): this person already
    // has a row for this tenant. NOT automatically INVITE_DUPLICATE - review
    // fix C1. Doc 32 §7.1: "Resend regenerates token", and before this fix
    // there was no way to honour that: a revoked invite (status='disabled')
    // or one that simply expired (status stays 'invited' forever, doc 30
    // §2.7's 7-day TTL) permanently bricked that email against this tenant,
    // because the unique index means a fresh INSERT can never succeed again.
    // So: read the existing row and REACTIVATE it when it is not live,
    // rather than refuse.
    return reinviteExisting(supabase, business, actor, input, deps, resolved, token, expiresAt);
  }

  return commitInvite({
    supabase,
    business,
    actor,
    input,
    deps,
    resolved,
    row: inserted,
    auditAction: STAFF_AUDIT_ACTIONS.invited,
    before: null,
    revert: async () => {
      // The row was JUST created, so undoing it is a hard delete rather than
      // restoring a prior state - there is no prior state.
      const { error } = await supabase.from("business_staff").delete().eq("id", inserted.id);
      if (error !== null) {
        console.error(
          `[businesses/staff] UNAUDITED CHANGE: invite ${inserted.id} could not be recorded and could not be reverted`,
          error,
        );
      }
    },
  });
}

/**
 * The C1 reactivation path: `insertError.code === UNIQUE_VIOLATION` already
 * happened, so a row for (business.id, resolved.userId) exists. Reads it,
 * decides LIVE (genuine duplicate) vs REACTIVATABLE, and on the latter
 * flips it back to a fresh, single-use 'invited' row.
 *
 * "LIVE" is deliberately narrow: an active member, or an invited row whose
 * `invite_expires_at` has not yet passed. Everything else - disabled
 * (revoked, or a former staff member removed and never re-added), or
 * invited-but-expired - is fair game to reactivate. The CAS on the
 * reactivating UPDATE (`.eq("status", existing.status)`) protects against a
 * race where the row changed between this read and the write (e.g. accepted
 * concurrently): a lost race reports a plain failure, never a silent
 * overwrite of a row that just became active.
 */
async function reinviteExisting(
  supabase: SupabaseClient<Database>,
  business: Business,
  actor: StaffActor,
  input: InviteInput,
  deps: StaffServiceDeps,
  resolved: ResolvedInvitee,
  token: string,
  expiresAt: string,
): Promise<ActionResult<StaffRosterItem>> {
  const { data: existing, error: readError } = await supabase
    .from("business_staff")
    .select(ROSTER_COLUMNS)
    .eq("business_id", business.id)
    .eq("user_id", resolved.userId)
    .maybeSingle<BusinessStaffRow>();

  if (readError !== null || existing === null) {
    console.error("[businesses/staff] could not read the existing row behind a 23505", readError);
    return { ok: false, message: "Could not send this invite. Try again." };
  }

  const stillLive =
    existing.status === "active" ||
    (existing.status === "invited" &&
      (existing.invite_expires_at === null ||
        new Date(existing.invite_expires_at).getTime() >= Date.now()));

  if (stillLive) {
    return {
      ok: false,
      code: "INVITE_DUPLICATE",
      message: "This person is already a member or already has a pending invite.",
    };
  }

  const { data: reactivated, error: writeError } = await supabase
    .from("business_staff")
    .update({
      role: input.role,
      status: "invited",
      invited_email: input.email,
      invite_token: token,
      invite_expires_at: expiresAt,
      updated_by: actor.userId,
    })
    .eq("id", existing.id)
    .eq("status", existing.status)
    .select(ROSTER_COLUMNS)
    .single<BusinessStaffRow>();

  if (writeError !== null || reactivated === null) {
    console.error("[businesses/staff] invite reactivation failed", writeError);
    return { ok: false, message: "Could not send this invite. Try again." };
  }

  return commitInvite({
    supabase,
    business,
    actor,
    input,
    deps,
    resolved,
    row: reactivated,
    auditAction: STAFF_AUDIT_ACTIONS.invite_resent,
    before: { status: existing.status, role: existing.role } as Json,
    revert: async () => {
      const { error } = await supabase
        .from("business_staff")
        .update({
          role: existing.role,
          status: existing.status,
          invited_email: existing.invited_email,
          invite_token: existing.invite_token,
          invite_expires_at: existing.invite_expires_at,
        })
        .eq("id", existing.id);
      if (error !== null) {
        console.error(
          `[businesses/staff] UNAUDITED CHANGE: reactivation of invite ${existing.id} could not be recorded and could not be reverted`,
          error,
        );
      }
    },
  });
}

interface CommitInviteArgs {
  supabase: SupabaseClient<Database>;
  business: Business;
  actor: StaffActor;
  input: InviteInput;
  deps: StaffServiceDeps;
  resolved: ResolvedInvitee;
  row: BusinessStaffRow;
  auditAction: (typeof STAFF_AUDIT_ACTIONS)[keyof typeof STAFF_AUDIT_ACTIONS];
  before: Json;
  revert: () => Promise<void>;
}

/** The tail every invite-issuing path (fresh insert, or C1's reactivation)
 * shares: audit (revert on failure), then a best-effort send. Pulled out
 * once there were two callers, so the write-then-audit-else-revert shape
 * cannot drift between them. */
async function commitInvite(args: CommitInviteArgs): Promise<ActionResult<StaffRosterItem>> {
  const audit = await writeStaffAuditRow(args.supabase, {
    businessId: args.business.id,
    staffId: args.row.id,
    action: args.auditAction,
    actorId: args.actor.userId,
    actorRole: args.actor.role,
    before: args.before,
    after: { role: args.input.role, invitedEmail: args.input.email, status: "invited" } as Json,
    reason: null,
    requestId: null,
  });

  if (!audit.ok) {
    await args.revert();
    return {
      ok: false,
      message: "This invite could not be recorded, so it was not sent. Try again.",
    };
  }

  // Best-effort, see notify.ts's header: the row (audited above) is the
  // source of truth, this is a courtesy.
  await args.deps.sendInviteEmail({
    to: args.input.email,
    businessName: args.business.name,
    role: args.input.role,
    token: args.row.invite_token ?? "",
    newAccountSetupLink: args.resolved.actionLink,
  });

  return { ok: true, data: mapRow(args.row) };
}

/** Revokes a pending invite. Same target-role restriction as inviting
 * (`canActOnRole`), by the symmetry argument in roles.ts. */
export async function revokeInvite(
  business: Business,
  actor: StaffActor,
  staffId: string,
): Promise<ActionResult<undefined>> {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error("[businesses/staff] no service-role key: revoke could not be written");
    return UNAVAILABLE;
  }

  const { data: existing, error: readError } = await supabase
    .from("business_staff")
    .select(ROSTER_COLUMNS)
    .eq("id", staffId)
    .eq("business_id", business.id)
    .eq("status", "invited")
    .maybeSingle<BusinessStaffRow>();

  if (readError !== null) {
    console.error("[businesses/staff] revoke read failed", readError);
    return { ok: false, message: "Could not read that invite." };
  }
  if (existing === null) {
    return { ok: false, message: "That invite no longer exists, or was already used." };
  }
  if (!canActOnRole(actor.role, existing.role as BusinessRole)) {
    return {
      ok: false,
      code: "NOT_ALLOWED",
      message: "A manager can only revoke a staff invite.",
    };
  }

  // CAS on status='invited': loses cleanly to a concurrent accept rather than
  // clobbering a row that just became 'active'.
  const { data: updated, error: writeError } = await supabase
    .from("business_staff")
    .update({ status: "disabled", invite_token: null, updated_by: actor.userId })
    .eq("id", staffId)
    .eq("status", "invited")
    .select(ROSTER_COLUMNS)
    .maybeSingle<BusinessStaffRow>();

  if (writeError !== null) {
    console.error("[businesses/staff] revoke write failed", writeError);
    return { ok: false, message: "Could not revoke that invite." };
  }
  if (updated === null) {
    return { ok: false, message: "That invite was just accepted or already revoked." };
  }

  const audit = await writeStaffAuditRow(supabase, {
    businessId: business.id,
    staffId,
    action: STAFF_AUDIT_ACTIONS.invite_revoked,
    actorId: actor.userId,
    actorRole: actor.role,
    before: { status: "invited", invitedEmail: existing.invited_email } as Json,
    after: { status: "disabled" } as Json,
    reason: null,
    requestId: null,
  });

  if (!audit.ok) {
    await revertToInvited(supabase, staffId, existing);
    return {
      ok: false,
      message: "This revoke could not be recorded, so it was undone. Try again.",
    };
  }

  return { ok: true };
}

async function revertToInvited(
  supabase: SupabaseClient<Database>,
  staffId: string,
  original: BusinessStaffRow,
): Promise<void> {
  const { error } = await supabase
    .from("business_staff")
    .update({
      status: original.status,
      invite_token: original.invite_token,
    })
    .eq("id", staffId);
  if (error !== null) {
    console.error(
      `[businesses/staff] UNAUDITED CHANGE: revoke of ${staffId} could not be recorded and could not be reverted`,
      error,
    );
  }
}

/** Changes an active member's role. Owner-only (doc 01: "Change staff roles":
 * owner only, no manager exception), and the owner row itself is never a
 * valid target in either direction - doc 32 section 7.1: "owner role is not
 * assignable here; ownership transfer is an atomic swap [V1] in settings." */
export async function changeRole(
  business: Business,
  actor: StaffActor,
  input: ChangeRoleInput,
): Promise<ActionResult<StaffRosterItem>> {
  if (!ROLE_CHANGE_ROLES.includes(actor.role)) {
    return { ok: false, code: "NOT_ALLOWED", message: "Only an owner can change a staff member's role." };
  }
  if (input.role === "owner") {
    // NOT_ALLOWED, not OWNER_REQUIRED (review fix M13): doc 32's
    // OWNER_REQUIRED is specifically "any action that would leave zero
    // owners" - promoting a SECOND member to owner does not threaten that
    // invariant (there would still be one), it is simply a different flow
    // entirely ("ownership transfer is an atomic swap [V1] in settings").
    return {
      ok: false,
      code: "NOT_ALLOWED",
      message: "Ownership cannot be reassigned here. Transfer ownership from settings instead.",
    };
  }

  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error("[businesses/staff] no service-role key: role change could not be written");
    return UNAVAILABLE;
  }

  const { data: existing, error: readError } = await supabase
    .from("business_staff")
    .select(ROSTER_COLUMNS)
    .eq("id", input.staffId)
    .eq("business_id", business.id)
    .eq("status", "active")
    .maybeSingle<BusinessStaffRow>();

  if (readError !== null) {
    console.error("[businesses/staff] role-change read failed", readError);
    return { ok: false, message: "Could not read that staff member." };
  }
  if (existing === null) {
    return { ok: false, message: "That staff member was not found." };
  }
  if (existing.role === "owner") {
    // OWNER_REQUIRED IS correct here (unlike the branch above): the target
    // row already holds the tenant's one and only 'owner' row
    // (`business_staff_one_owner`, 0002's partial unique index), so changing
    // it away is EXACTLY "an action that would leave zero owners".
    return {
      ok: false,
      code: "OWNER_REQUIRED",
      message: "The owner's role cannot be changed here.",
    };
  }

  const { data: updated, error: writeError } = await supabase
    .from("business_staff")
    .update({ role: input.role, updated_by: actor.userId })
    .eq("id", input.staffId)
    .eq("status", "active")
    .neq("role", "owner")
    .select(ROSTER_COLUMNS)
    .maybeSingle<BusinessStaffRow>();

  if (writeError !== null) {
    console.error("[businesses/staff] role-change write failed", writeError);
    return { ok: false, message: "Could not change that role." };
  }
  if (updated === null) {
    return { ok: false, message: "That staff member changed while you were working. Refresh and try again." };
  }

  const audit = await writeStaffAuditRow(supabase, {
    businessId: business.id,
    staffId: input.staffId,
    action: STAFF_AUDIT_ACTIONS.role_changed,
    actorId: actor.userId,
    actorRole: actor.role,
    before: { role: existing.role } as Json,
    after: { role: input.role } as Json,
    reason: null,
    requestId: null,
  });

  if (!audit.ok) {
    const { error } = await supabase
      .from("business_staff")
      .update({ role: existing.role })
      .eq("id", input.staffId);
    if (error !== null) {
      console.error(
        `[businesses/staff] UNAUDITED CHANGE: role change of ${input.staffId} could not be recorded and could not be reverted`,
        error,
      );
    }
    return {
      ok: false,
      message: "This role change could not be recorded, so it was undone. Try again.",
    };
  }

  return { ok: true, data: mapRow(updated) };
}

export interface AcceptedInvite {
  businessId: string;
}

export interface InvitePreview {
  businessName: string;
  role: BusinessRole;
  invitedEmail: string | null;
}

/**
 * Read-only lookup for `/invite/[token]`'s initial render. Deliberately NEVER
 * mutates the row - a GET of this page (a mail client's link-scanner, a
 * "preview" fetch, a bot) must not be able to consume a single-use invite by
 * merely being requested. The actual accept is a separate action
 * (`acceptInvite` below), reached only by an explicit click, which Next
 * server actions always send as a POST regardless of how the page got
 * there - see actions.ts's `acceptInviteAction`.
 *
 * Shares `acceptInvite`'s not-found/status/expiry checks (same codes,
 * INVITE_INVALID / INVITE_EXPIRED) so the page and the accept button never
 * disagree about whether a token is live.
 */
export async function previewInvite(token: string): Promise<ActionResult<InvitePreview>> {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error("[businesses/staff] no service-role key: invite could not be read");
    return UNAVAILABLE;
  }

  const { data: row, error: readError } = await supabase
    .from("business_staff")
    .select(ROSTER_COLUMNS)
    .eq("invite_token", token)
    .maybeSingle<BusinessStaffRow>();

  if (readError !== null) {
    console.error("[businesses/staff] invite preview read failed", readError);
    return { ok: false, message: "Could not read this invite." };
  }
  if (row === null || row.status !== "invited") {
    return { ok: false, code: "INVITE_INVALID", message: "This invite link is no longer valid." };
  }
  if (row.invite_expires_at !== null && new Date(row.invite_expires_at).getTime() < Date.now()) {
    return {
      ok: false,
      code: "INVITE_EXPIRED",
      message: "This invite has expired. Ask the business to send a new one.",
    };
  }

  const { data: business } = await supabase
    .from("businesses")
    .select("name")
    .eq("id", row.business_id)
    .maybeSingle<{ name: string }>();

  return {
    ok: true,
    data: {
      businessName: business?.name ?? "this business",
      role: row.role as BusinessRole,
      invitedEmail: row.invited_email,
    },
  };
}

/**
 * `/invite/[token]` acceptance.
 *
 * THE WRONG-ACCOUNT DECISION (brief: "decide what happens and make it
 * explicit"). Because `user_id` is resolved/created at INVITE time (see
 * `defaultResolveInvitee`), not at accept time, the row already names exactly
 * one account before this ever runs - accepting is "confirm you are that
 * account", never "bind whichever account happens to be signed in". So:
 *   - no session at all         -> SIGN_IN_REQUIRED, named account in the message
 *   - session, wrong account    -> WRONG_ACCOUNT, explicit refusal, NO write
 *   - session, matching account -> flips status, single-use via CAS
 * The alternative this refuses is silently re-pointing the invite at whoever
 * is currently signed in, which is exactly the failure the brief names as the
 * one to avoid.
 */
export async function acceptInvite(
  token: string,
  sessionUserId: string | null,
): Promise<ActionResult<AcceptedInvite>> {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error("[businesses/staff] no service-role key: invite could not be read");
    return UNAVAILABLE;
  }

  // Service role, not the session client: an invitee accepting is by
  // definition not yet an active member of this tenant, so
  // `business_staff_tenant_select` (which requires an ACTIVE membership)
  // grants them nothing to read - the token itself is the authorization,
  // exactly the way a password-reset token stands in for a session.
  const { data: row, error: readError } = await supabase
    .from("business_staff")
    .select(ROSTER_COLUMNS)
    .eq("invite_token", token)
    .maybeSingle<BusinessStaffRow>();

  if (readError !== null) {
    console.error("[businesses/staff] invite read failed", readError);
    return { ok: false, message: "Could not read this invite." };
  }
  if (row === null || row.status !== "invited") {
    return {
      ok: false,
      code: "INVITE_INVALID",
      message: "This invite link is no longer valid.",
    };
  }
  if (row.invite_expires_at !== null && new Date(row.invite_expires_at).getTime() < Date.now()) {
    return {
      ok: false,
      code: "INVITE_EXPIRED",
      message: "This invite has expired. Ask the business to send a new one.",
    };
  }
  if (sessionUserId === null) {
    return {
      ok: false,
      code: "SIGN_IN_REQUIRED",
      message: row.invited_email
        ? `Sign in as ${row.invited_email} to accept this invite.`
        : "Sign in to accept this invite.",
    };
  }
  if (sessionUserId !== row.user_id) {
    return {
      ok: false,
      code: "WRONG_ACCOUNT",
      message: row.invited_email
        ? `This invite was sent to ${row.invited_email}. Sign out and sign in as that account to accept it.`
        : "This invite was sent to a different account.",
    };
  }

  const { data: updated, error: writeError } = await supabase
    .from("business_staff")
    .update({ status: "active", invite_token: null, updated_by: sessionUserId })
    .eq("id", row.id)
    .eq("status", "invited")
    .eq("invite_token", token)
    .select(ROSTER_COLUMNS)
    .maybeSingle<BusinessStaffRow>();

  if (writeError !== null) {
    console.error("[businesses/staff] accept write failed", writeError);
    return { ok: false, message: "Could not accept this invite." };
  }
  if (updated === null) {
    return {
      ok: false,
      code: "INVITE_INVALID",
      message: "This invite was just used. Refresh and try again.",
    };
  }

  const audit = await writeStaffAuditRow(supabase, {
    businessId: row.business_id,
    staffId: row.id,
    action: STAFF_AUDIT_ACTIONS.invite_accepted,
    actorId: sessionUserId,
    actorRole: row.role,
    before: { status: "invited" } as Json,
    after: { status: "active", userId: sessionUserId } as Json,
    reason: null,
    requestId: null,
  });

  if (!audit.ok) {
    const { error } = await supabase
      .from("business_staff")
      .update({ status: "invited", invite_token: token })
      .eq("id", row.id);
    if (error !== null) {
      console.error(
        `[businesses/staff] UNAUDITED CHANGE: accept of ${row.id} could not be recorded and could not be reverted`,
        error,
      );
    }
    return {
      ok: false,
      message: "This could not be recorded, so it was not completed. Try again.",
    };
  }

  return { ok: true, data: { businessId: row.business_id } };
}
