import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/lib/supabase/types";

import { normalizeForMatch } from "../matching";

// ===========================================================================
// "This is my receipt header, always accept it."
//
// The one-tap affordance on the review decision screen, and the mechanism that
// makes the merchant-name check TEACH itself rather than merely accuse. A
// merchant whose slips are headed differently from their registered Giya name
// taps this once and stops seeing that receipt in their queue; after a few
// reviews the shop is self-tuned. That self-tuning is the entire reason the
// check can be enforced from receipt one with no grace period - a grace period
// would leave the foreign-receipt hole open exactly when a shop is too new to
// notice leakage, and would remove any reason to ever configure an alias.
//
// FOUR THINGS THIS FUNCTION IS CAREFUL ABOUT. Every one of them is here
// because an alias WIDENS WHAT AUTO-APPROVES AT A MERCHANT, which makes this a
// money-path write and not a preferences toggle.
//
//  1. THE ALIAS STRING NEVER COMES FROM THE BROWSER. The caller supplies a
//     receipt id and nothing else; the header is re-read from that receipt's
//     `parse_meta.merchant_check.header_text`, which is the pipeline's own
//     copy of what it read off the paper. A client-supplied string would let
//     one compromised reviewer session widen acceptance to any header they
//     like - "%", a rival's name, a bare space - and no amount of validation
//     on this side would make that a good idea.
//  2. TENANCY IS RE-DERIVED FROM THE RECEIPT. The alias is written against
//     `receipts.business_id`, and only after that id has been checked against
//     the reviewer's own tenant. Naming a business in the payload would let a
//     caller widen another merchant's acceptance list.
//  3. THE WRITE IS IDEMPOTENT AND RACE-FREE. `on conflict do nothing` against
//     0034's `(business_id, alias_normalized)` unique index, so a double tap,
//     a retried action, or two reviewers on two receipts carrying the same
//     header all converge on one row. This is why 0034 is a table and not an
//     array column: appending to an array is a read-modify-write that silently
//     loses one of two concurrent aliases.
//  4. IT WRITES AN AUDIT ROW. Doc 25's append-only log already records every
//     receipt decision; a change to what will auto-approve in future is at
//     least as consequential as a decision on one receipt, and "who taught
//     this alias" is the first question anyone asks when one turns out wrong.
//
// The check itself and its threshold live in ../matching.ts; this module only
// stores what a human confirmed.
// ===========================================================================

const AUDIT_ACTION_ALIAS_LEARNED = "receipt.merchant_alias_learned";
/** Matches `AUDIT_ENTITY_TYPE` in ./review.ts: the subject is still a receipt. */
const AUDIT_ENTITY_TYPE = "receipt";

/** 0034's `char_length(btrim(alias)) between 2 and 200`, mirrored so a bad
 * header is refused with a sentence rather than a 23514 from the driver. */
const ALIAS_MIN_LENGTH = 2;
const ALIAS_MAX_LENGTH = 200;

export type LearnAliasErrorCode =
  | "DEPENDENCY_UNAVAILABLE"
  | "RECEIPT_NOT_FOUND"
  | "NO_HEADER_TEXT"
  | "ALIAS_WRITE_FAILED";

export type LearnAliasOutcome =
  | { ok: true; alias: string; alreadyKnown: boolean }
  | { ok: false; code: LearnAliasErrorCode; message: string };

export interface LearnAliasDeps {
  /** SERVICE ROLE. `parse_meta` is withheld from `authenticated` by 0017. */
  supabase: SupabaseClient<Database>;
  now: () => Date;
}

export function defaultLearnAliasDeps(): LearnAliasDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error(
      "[receipts/alias] SUPABASE_SERVICE_ROLE_KEY is not configured; cannot learn aliases",
    );
    return null;
  }
  return { supabase, now: () => new Date() };
}

export interface LearnMerchantAliasInput {
  receiptId: string;
  /** From the session, never from the payload. Lands in `audit_logs.actor_id`. */
  actorId: string;
  /** The reviewer's own tenant, resolved from table truth by the caller. */
  businessId: string;
  actorRole: string;
  requestId: string;
  deps?: LearnAliasDeps | null;
}

interface ReceiptAliasRow {
  id: string;
  business_id: string | null;
  parse_meta: Json;
}

function fail(code: LearnAliasErrorCode, message: string): LearnAliasOutcome {
  return { ok: false, code, message };
}

/**
 * Pull the header the pipeline recorded, or null.
 *
 * Defensive at every level because `parse_meta` is jsonb: a row written by an
 * older build has no `merchant_check` at all, and a row written by a future
 * one may have a shape this code has never seen. Both answer null, which the
 * caller turns into "there is nothing to learn from this receipt" rather than
 * into a crash on a screen a merchant is trying to work through.
 */
export function headerTextFromParseMeta(parseMeta: unknown): string | null {
  if (typeof parseMeta !== "object" || parseMeta === null || Array.isArray(parseMeta)) {
    return null;
  }
  const check = (parseMeta as Record<string, unknown>).merchant_check;
  if (typeof check !== "object" || check === null || Array.isArray(check)) return null;
  const header = (check as Record<string, unknown>).header_text;
  if (typeof header !== "string") return null;
  const trimmed = header.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function learnMerchantAlias(
  input: LearnMerchantAliasInput,
): Promise<LearnAliasOutcome> {
  const deps = input.deps === undefined ? defaultLearnAliasDeps() : input.deps;
  if (deps === null) {
    return fail(
      "DEPENDENCY_UNAVAILABLE",
      "Receipt review is temporarily unavailable. Try again shortly.",
    );
  }

  // GUARD 1: the receipt exists AND belongs to the reviewer's tenant. The
  // business_id predicate is applied in the query rather than compared
  // afterwards, so a receipt from another business is indistinguishable from
  // one that does not exist - a reviewer probing ids learns nothing either way.
  const { data: receipt, error: loadError } = await deps.supabase
    .from("receipts")
    .select("id, business_id, parse_meta")
    .eq("id", input.receiptId)
    .eq("business_id", input.businessId)
    .maybeSingle<ReceiptAliasRow>();

  if (loadError !== null) {
    console.error(`[receipts/alias] could not load receipt ${input.receiptId}`, loadError);
    return fail("RECEIPT_NOT_FOUND", "That receipt could not be found. Refresh and try again.");
  }
  if (receipt === null || receipt.business_id === null) {
    return fail("RECEIPT_NOT_FOUND", "That receipt could not be found. Refresh and try again.");
  }

  // GUARD 2: there is a header to learn, and it is the PIPELINE's copy of it.
  const alias = headerTextFromParseMeta(receipt.parse_meta);
  if (alias === null) {
    return fail(
      "NO_HEADER_TEXT",
      "We did not read a shop name on this receipt, so there is nothing to remember.",
    );
  }
  if (alias.length < ALIAS_MIN_LENGTH || alias.length > ALIAS_MAX_LENGTH) {
    return fail(
      "NO_HEADER_TEXT",
      "The shop name we read is too short or too long to remember. Approve this receipt on its own merits.",
    );
  }
  // 0034's non-empty check on the generated column, tested here so an
  // all-punctuation header is refused with a sentence instead of a 23514.
  if (normalizeForMatch(alias).length === 0) {
    return fail(
      "NO_HEADER_TEXT",
      "We did not read a shop name on this receipt, so there is nothing to remember.",
    );
  }

  // THE WRITE. `ignoreDuplicates` is what turns 0034's unique index into an
  // idempotent tap rather than a 23505 on the second one.
  const { data: inserted, error: insertError } = await deps.supabase
    .from("business_merchant_aliases")
    .upsert(
      {
        business_id: receipt.business_id,
        alias,
        source: "learned",
        receipt_id: receipt.id,
        created_by: input.actorId,
      },
      { onConflict: "business_id,alias_normalized", ignoreDuplicates: true },
    )
    .select("id");

  if (insertError !== null) {
    console.error(
      `[receipts/alias] could not store the alias for business ${receipt.business_id}`,
      insertError,
    );
    return fail("ALIAS_WRITE_FAILED", "That did not save. Refresh and try again.");
  }

  // An ignored duplicate returns no row. That is a SUCCESS with different copy
  // ("we already knew that one"), never an error: the merchant asked for a
  // state, and the state holds.
  const alreadyKnown = !Array.isArray(inserted) || inserted.length === 0;

  const { error: auditError } = await deps.supabase.from("audit_logs").insert({
    actor_id: input.actorId,
    actor_kind: "user",
    actor_role: input.actorRole,
    business_id: receipt.business_id,
    action: AUDIT_ACTION_ALIAS_LEARNED,
    entity_type: AUDIT_ENTITY_TYPE,
    entity_id: receipt.id,
    // The diff is the acceptance list widening, which is the thing worth
    // recording. No receipt fields are copied in: doc 25 makes PII
    // minimization the writer's job, and this write changes none of them.
    before: {} as Json,
    after: { merchant_alias: alias, source: "learned" } as Json,
    reason: "merchant confirmed the receipt header on review",
    request_id: input.requestId,
  });
  if (auditError !== null) {
    // The alias is already stored. Losing the audit row is a real problem and
    // is logged as one, but undoing a write the merchant asked for - and which
    // is idempotent, so a retry cannot fix the log either - would be worse.
    console.error(
      `[receipts/alias] could not audit the alias learned on receipt ${receipt.id}`,
      auditError,
    );
  }

  console.info(
    `[receipts/alias] business ${receipt.business_id} learned a merchant alias from receipt ${receipt.id} by ${input.actorRole} ${input.actorId} request=${input.requestId}`,
  );
  return { ok: true, alias, alreadyKnown };
}
