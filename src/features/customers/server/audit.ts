import "server-only";

import { createServiceRoleClient } from "@/lib/supabase/service";

import type { CustomerSegment } from "../types";

// ===========================================================================
// `customer.segment_changed`, one of the verbs migration 0022 registers by
// name. Blacklisting is step 3 of doc 37's consequences ladder and it is a
// human judgement call made by someone inside the tenant that benefits from it,
// so it is exactly the class of action doc 15's threat model item 6 (insider
// abuse) says must leave a record.
//
// WHY SERVICE ROLE. 0022 revokes every client write on `audit_logs` at the
// privilege layer and keeps INSERT for `service_role` only, so there is no
// session-scoped path to write this row. The client is created here rather than
// passed in so the credential never travels through a server action's argument
// list.
//
// WHAT IS RECORDED. `before`/`after` carry the segment and nothing else. The
// column is granted to the tenant owner (0022's read policy), so anything put
// in it is published to that tenant - doc 15's PII minimization is not advice
// here, it is the reason this shape is two words wide.
// ===========================================================================

const AUDIT_ACTION_SEGMENT_CHANGED = "customer.segment_changed";

/**
 * `audit_logs.entity_type`, singular subject noun, matching the convention
 * src/features/receipts/server/review.ts fixed for `receipt`.
 */
const AUDIT_ENTITY_TYPE = "business_customer";

export interface SegmentChangeAudit {
  actorId: string;
  actorRole: string;
  businessId: string;
  customerId: string;
  before: CustomerSegment;
  after: CustomerSegment;
  reason: string | null;
}

export type AuditOutcome =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Writes the segment-change audit row.
 *
 * A MISSING SERVICE-ROLE KEY IS A DOCUMENTED DEGRADED PATH, not a failure:
 * `createServiceRoleClient` returns null when `SUPABASE_SERVICE_ROLE_KEY` is
 * unset (its own header explains why - credentials arrive at the end of a
 * build), and every caller in this codebase is required to have a degraded
 * path. Refusing the segment change in that case would mean a merchant cannot
 * block a fraudulent customer because a log line cannot be written, which
 * trades a real protection for a record of it. It logs loudly instead.
 *
 * A genuine INSERT ERROR is different: the credential is present and Postgres
 * refused, which means something is wrong with the row or the table, and the
 * caller surfaces it.
 */
export async function recordSegmentChange(input: SegmentChangeAudit): Promise<AuditOutcome> {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.warn(
      `[customers] no service-role key: segment change for customer ${input.customerId} was applied but not audited`,
    );
    return { ok: true };
  }

  const { error } = await supabase.from("audit_logs").insert({
    actor_id: input.actorId,
    actor_kind: "user",
    actor_role: input.actorRole,
    business_id: input.businessId,
    action: AUDIT_ACTION_SEGMENT_CHANGED,
    entity_type: AUDIT_ENTITY_TYPE,
    entity_id: input.customerId,
    before: { segment: input.before },
    after: { segment: input.after },
    reason: input.reason,
  });

  if (error) {
    console.error("[customers] could not write the segment-change audit row", error);
    return { ok: false, message: error.message };
  }

  return { ok: true };
}
