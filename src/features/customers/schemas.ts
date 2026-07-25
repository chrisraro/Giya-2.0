import { z } from "zod";

import { CUSTOMER_SEGMENTS } from "./types";

// Zod schemas for the CRM's two writes. Both are deliberately narrow: the ONLY
// columns of `business_customers` any client may write are `segment`, `notes`
// and `updated_by` (supabase/migrations/0013_reward_claim_rpcs.sql revoked
// table UPDATE from `authenticated` and granted back exactly those three), and
// the input shapes here cannot express anything else.

export const idSchema = z.string().uuid();

export const CUSTOMER_NOTES_MAX_LENGTH = 2000;
export const SEGMENT_REASON_MAX_LENGTH = 500;
export const SEGMENT_REASON_MIN_LENGTH = 4;

export const segmentSchema = z.enum(CUSTOMER_SEGMENTS);

/**
 * Doc 32 section 8: "Blacklisting requires a typed reason -> audit
 * `customer.segment_changed`." The reason is required only for the segment that
 * takes something away, because that is the one a customer may later dispute
 * and the one doc 37's consequences ladder (step 3) treats as an owner/manager
 * judgement call. Promoting someone to `vip` needs no justification.
 */
export const changeSegmentSchema = z
  .object({
    customerId: idSchema,
    segment: segmentSchema,
    reason: z.string().trim().max(SEGMENT_REASON_MAX_LENGTH).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.segment !== "blacklisted") return;
    if (!value.reason || value.reason.length < SEGMENT_REASON_MIN_LENGTH) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Say why this customer is being blocked. The reason is recorded in your activity log.",
      });
    }
  });
export type ChangeSegmentInput = z.infer<typeof changeSegmentSchema>;

export const updateNotesSchema = z.object({
  customerId: idSchema,
  notes: z.string().trim().max(CUSTOMER_NOTES_MAX_LENGTH),
});
export type UpdateNotesInput = z.infer<typeof updateNotesSchema>;
