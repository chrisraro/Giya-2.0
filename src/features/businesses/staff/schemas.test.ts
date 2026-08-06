import { describe, it, expect, vi } from "vitest";

// schemas.ts imports BUSINESS_ROLES from ../server/resolve-owner-business,
// which imports @/lib/supabase/server at module load time - unused by
// anything this file exercises, but it still needs a mock so importing the
// module tree does not hit real env validation (same shape as the
// /business/staff page test's own note).
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: vi.fn() } })),
}));

const { inviteSchema, changeRoleSchema, tokenSchema, staffIdSchema } = await import("./schemas");

// Previously untested: this module's own comment claims "owner is
// deliberately IN this enum ... the schema accepts the whole domain, the
// service layer applies the narrower business rule" for both inviteSchema
// and changeRoleSchema, and inviteSchema's email field claims to normalize
// (trim + lowercase) before the RPC-based resolver (service.ts's
// `findExistingAuthUser`) ever sees it. Neither claim had a test pinning it.

describe("inviteSchema: email normalization", () => {
  it("lowercases and trims the email before it reaches the service layer", () => {
    // Mutant: dropping `.toLowerCase()` (or `.trim()`) from the schema would
    // still validate a mixed-case/whitespace-padded address as a legal
    // email, so only a value-shape assertion (not just `.success`) pins
    // this - `find_auth_user_by_email` (0063) ALSO normalizes on the SQL
    // side, but relying on that alone would leave this schema's own claim
    // ("email: z.string().trim().toLowerCase()...") unproven.
    const parsed = inviteSchema.parse({ email: "  Someone@Example.COM  ", role: "staff" });

    expect(parsed.email).toBe("someone@example.com");
  });

  it("rejects a string that is not a valid email shape, even after normalization", () => {
    const result = inviteSchema.safeParse({ email: "not-an-email", role: "staff" });

    expect(result.success).toBe(false);
  });
});

describe("inviteSchema and changeRoleSchema: accept the WHOLE role domain, including owner", () => {
  // The comment above both schemas in schemas.ts claims this deliberately -
  // roles.ts's canActOnRole is what refuses "owner" as a target, not the
  // schema - so a payload naming role:"owner" must reach the SERVICE layer
  // (and its specific, named refusal) rather than fail here with a generic
  // validation error that would read as a client bug.
  it("inviteSchema parses role: 'owner' successfully (the refusal is the service's job, not this schema's)", () => {
    // Mutant: narrowing the enum to exclude "owner" would make this schema
    // itself the refusal point, and a payload naming owner would get a
    // generic Zod error message instead of roles.ts's specific one
    // ("Ownership cannot be granted by invite...").
    const result = inviteSchema.safeParse({ email: "new@example.com", role: "owner" });

    expect(result.success).toBe(true);
  });

  it("changeRoleSchema parses role: 'owner' successfully, for the same reason", () => {
    const result = changeRoleSchema.safeParse({
      staffId: "11111111-1111-4111-8111-111111111111",
      role: "owner",
    });

    expect(result.success).toBe(true);
  });

  it("both schemas still reject a role outside the real domain", () => {
    expect(inviteSchema.safeParse({ email: "new@example.com", role: "superadmin" }).success).toBe(
      false,
    );
    expect(
      changeRoleSchema.safeParse({
        staffId: "11111111-1111-4111-8111-111111111111",
        role: "superadmin",
      }).success,
    ).toBe(false);
  });
});

describe("staffIdSchema / tokenSchema: the narrow shapes actions.ts relies on", () => {
  it("staffIdSchema requires a real uuid, not just a non-empty string", () => {
    expect(staffIdSchema.safeParse("not-a-uuid").success).toBe(false);
    expect(staffIdSchema.safeParse("11111111-1111-4111-8111-111111111111").success).toBe(true);
  });

  it("tokenSchema rejects an empty string", () => {
    expect(tokenSchema.safeParse("").success).toBe(false);
  });
});
