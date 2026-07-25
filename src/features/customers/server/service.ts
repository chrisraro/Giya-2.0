import type { ChangeSegmentInput, UpdateNotesInput } from "../schemas";
import type {
  ActionResult,
  BusinessCustomerRow,
  CustomerListItem,
  CustomerSegment,
  CustomerSort,
  SegmentFilter,
} from "../types";
import { isCustomerSegment } from "../types";
import { recordSegmentChange } from "./audit";
import * as repo from "./repo";

// Orchestration over repo.ts: shape rows for the screen, and run the two
// writes. The column fence lives in repo.ts; this layer's job is to build
// patches that only ever name granted columns, and to keep the audit row
// attached to the one write that needs it.

/**
 * A short, stable, human-quotable handle for a customer row.
 *
 * The merchant cannot be shown a name (see the note on `CustomerListItem`), so
 * they get something they can say out loud to a colleague. Derived from the
 * consumer id, which the merchant's own session can already read on this row -
 * this reveals nothing new, it only makes an unreadable uuid quotable.
 */
export function customerReference(consumerId: string): string {
  return consumerId.replace(/-/g, "").slice(0, 4).toUpperCase();
}

function toListItem(row: BusinessCustomerRow): CustomerListItem {
  return {
    id: row.id,
    consumerId: row.consumer_id,
    reference: customerReference(row.consumer_id),
    // The DB check constrains this to three values; the cast is narrowed by a
    // real test rather than asserted, so a future fourth segment surfaces as
    // 'regular' on screen instead of as a type lie.
    segment: isCustomerSegment(row.segment) ? row.segment : "regular",
    pointsBalance: row.points_balance,
    lifetimePoints: row.lifetime_points,
    lifetimeSpendCentavos: row.lifetime_spend_centavos,
    visitCount: row.visit_count,
    firstVisitAt: row.first_visit_at,
    lastVisitAt: row.last_visit_at,
    notes: row.notes,
  };
}

export interface CustomerListView {
  customers: CustomerListItem[];
  /** True when the bounded first page came back full, so more rows exist. */
  truncated: boolean;
}

/**
 * The list screen's payload. Returns `{ ok: false }` on a query error so the
 * page can tell "we could not load this" apart from "this business has no
 * customers yet" - the same distinction menu/page.tsx makes, and one that
 * matters more here because a brand-new business genuinely has zero rows.
 */
export async function loadCustomers(
  businessId: string,
  options: { segment: SegmentFilter; sort: CustomerSort },
): Promise<ActionResult<CustomerListView>> {
  const { data, error } = await repo.listCustomers(businessId, options);
  if (error) return { ok: false, message: error.message };

  const rows = data ?? [];
  return {
    ok: true,
    data: {
      customers: rows.map(toListItem),
      truncated: rows.length >= repo.CUSTOMER_PAGE_SIZE,
    },
  };
}

export interface SegmentActor {
  userId: string;
  role: string;
}

/**
 * Moves a customer between segments.
 *
 * ORDER: write, then audit. The alternative (audit first, refuse the write if
 * the log fails) writes a record of something that may not have happened, which
 * is a worse property for a security log than a gap. If the log write then
 * fails, this returns `ok: false` with a message that says plainly that the
 * change WAS applied - a silent success would hide the missing record from the
 * only person who could go fix it. Same reasoning as
 * src/features/receipts/server/review.ts's audit ordering note.
 */
export async function changeSegment(
  businessId: string,
  actor: SegmentActor,
  input: ChangeSegmentInput,
): Promise<ActionResult<CustomerListItem>> {
  const existing = await repo.getCustomer(businessId, input.customerId);
  if (!existing) {
    return { ok: false, message: "That customer is not one of yours." };
  }

  const before: CustomerSegment = isCustomerSegment(existing.segment) ? existing.segment : "regular";
  if (before === input.segment) {
    return { ok: true, data: toListItem(existing) };
  }

  // Only granted columns. `updated_by` is in the grant precisely so a segment
  // change carries who made it, so it is set rather than left stale.
  const { data, error } = await repo.updateGrantedColumns(businessId, input.customerId, {
    segment: input.segment,
    updated_by: actor.userId,
  });

  if (error || !data) {
    return { ok: false, message: error?.message ?? "The segment could not be changed." };
  }

  const audit = await recordSegmentChange({
    actorId: actor.userId,
    actorRole: actor.role,
    businessId,
    customerId: input.customerId,
    before,
    after: input.segment,
    reason: input.reason ?? null,
  });

  if (!audit.ok) {
    return {
      ok: false,
      message:
        "The segment was changed, but it could not be written to your activity log. Tell the owner.",
    };
  }

  return { ok: true, data: toListItem(data) };
}

/**
 * Staff-visible note on a customer. Never shown to the customer (doc 21), which
 * the UI says out loud next to the field.
 */
export async function updateNotes(
  businessId: string,
  actor: SegmentActor,
  input: UpdateNotesInput,
): Promise<ActionResult<CustomerListItem>> {
  const { data, error } = await repo.updateGrantedColumns(businessId, input.customerId, {
    notes: input.notes === "" ? null : input.notes,
    updated_by: actor.userId,
  });

  if (error || !data) {
    return { ok: false, message: error?.message ?? "The note could not be saved." };
  }

  return { ok: true, data: toListItem(data) };
}
