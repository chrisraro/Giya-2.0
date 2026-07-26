import "server-only";

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Json } from "@/lib/supabase/types";

// =============================================================================
// The audit trail for connection changes.
// =============================================================================
//
// docs/10-architecture/15-security.md's coverage list includes "signed-URL
// grants on documents" and every state change that matters; handing a third
// party read access to a tenant's Page - and taking it away again - is
// squarely in that class. This is also the only record that will exist of who
// connected what: `integration_connections` rows are mutable and a reconnect
// upserts over the previous state, so without these rows the history is gone.
//
// VERBS REGISTERED BY THIS SLICE (doc 25's code registry, and 0022's shape
// constraint requires the dot):
//   integration.connected     - a Page was connected or reconnected
//   integration.disconnected  - the merchant disconnected it
//   integration.revoked       - Meta's deauthorize webhook ended the grant
//   integration.expired       - a token was found dead on read
//
// ACTOR KIND. Owner/manager actions are 'user', not 'admin': 0022's
// `audit_logs_admin_reason_required` makes a reason mandatory for 'admin'
// only, and demanding one for a merchant pressing Connect in their own portal
// would push callers into writing filler text, which devalues the field on the
// rows where it matters. The webhook writes 'system', which is what doc 25
// reserves for a worker-initiated change with no human behind it.
//
// WHAT IS RECORDED, AND WHAT IS NOT. `before`/`after` carry the status, the
// external account id and the granted scopes. THEY NEVER CARRY A TOKEN, in
// plaintext or ciphertext. 0022 grants `before`/`after` to the tenant owner,
// so anything put in them is published to that tenant - and a ciphertext
// published to the tenant is one stolen key away from being a token. The Page
// id is fine: it is in every public Page URL.

const AUDIT_ENTITY_TYPE = "integration_connection";

export const AUDIT_ACTIONS = {
  connected: "integration.connected",
  disconnected: "integration.disconnected",
  revoked: "integration.revoked",
  expired: "integration.expired",
} as const;

export type IntegrationAuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface ConnectionAuditInput {
  readonly action: IntegrationAuditAction;
  readonly businessId: string;
  readonly connectionId: string;
  /** `profiles.id`, or null for a system actor (the webhook). */
  readonly actorId: string | null;
  readonly actorKind: "user" | "system";
  /** The role held AT THE TIME, denormalized per 0022's column comment. */
  readonly actorRole: string | null;
  // `Json`, matching the column, so a value that cannot survive a round trip
  // through jsonb is a compile error rather than a runtime surprise. Note what
  // the shape does NOT stop: a caller could put a token in here. Nothing in
  // the type system can prevent that, which is why the rule is stated at the
  // top of this file and asserted in the test suite instead.
  readonly before: Json | null;
  readonly after: Json | null;
  readonly reason: string | null;
}

export type AuditOutcome = { ok: true } | { ok: false; message: string };

/**
 * Write one connection audit row.
 *
 * A MISSING SERVICE-ROLE KEY IS A DOCUMENTED DEGRADED PATH, exactly as
 * src/features/customers/server/audit.ts documents it: refusing a disconnect
 * because a log line cannot be written would trade a real protection (the
 * merchant revoking a third party's access to their Page) for a record of it.
 * It logs loudly and reports success.
 *
 * A genuine INSERT ERROR is different - the credential is present and Postgres
 * refused - and is surfaced to the caller.
 */
export async function recordConnectionChange(
  input: ConnectionAuditInput,
): Promise<AuditOutcome> {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.warn(
      `[integrations/meta] no service-role key: ${input.action} on connection ${input.connectionId} was applied but not audited`,
    );
    return { ok: true };
  }

  const { error } = await supabase.from("audit_logs").insert({
    actor_id: input.actorId,
    actor_kind: input.actorKind,
    actor_role: input.actorRole,
    business_id: input.businessId,
    action: input.action,
    entity_type: AUDIT_ENTITY_TYPE,
    entity_id: input.connectionId,
    before: input.before,
    after: input.after,
    reason: input.reason,
  });

  if (error !== null) {
    console.error("[integrations/meta] could not write the connection audit row", error.message);
    return { ok: false, message: error.message };
  }

  return { ok: true };
}
