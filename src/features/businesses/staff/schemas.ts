import { z } from "zod";

import { BUSINESS_ROLES } from "../server/resolve-owner-business";

// `owner` is deliberately IN this enum (roles.ts's `canActOnRole` is the gate
// that refuses it, same split settings.ts uses: the schema accepts the whole
// domain, the service layer applies the narrower business rule) - a payload
// naming `role: "owner"` must fail with roles.ts's own message ("owner role
// is not assignable here"), not with a generic schema-validation error that
// would read as a client bug rather than a deliberate refusal.
export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  role: z.enum(BUSINESS_ROLES),
});
export type InviteInput = z.infer<typeof inviteSchema>;

export const staffIdSchema = z.string().uuid();

export const changeRoleSchema = z.object({
  staffId: staffIdSchema,
  role: z.enum(BUSINESS_ROLES),
});
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

export const tokenSchema = z.string().min(1).max(512);
