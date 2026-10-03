// @vitest-environment node
//
// Server actions return typed results; they never crash. The tenancy resolvers
// now THROW when the membership read fails (a failed read is not "no access"),
// so every action that calls them must map the throw to a typed failure instead
// of rejecting the server-action call. One table, every caller, so a new action
// that forgets the guard has an obvious place to be added.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));

const boom = vi.hoisted(() => ({
  fail: () => Promise.reject(new Error("readMembership: read failed: connection reset")),
}));

vi.mock("@/features/businesses/server/resolve-owner-business", () => ({
  BUSINESS_SUSPENDED_MESSAGE: "suspended",
  BUSINESS_ROLES: ["owner", "manager", "marketing", "staff"],
  resolveStaffContext: boom.fail,
  resolveStaffAccess: boom.fail,
}));

const { saveBusinessProfile } = await import("./settings/actions");
const staff = await import("./staff/actions");
const { submitForReviewAction } = await import("./activation/actions");
const { uploadVerificationDocument } = await import("./onboarding/actions");
const customers = await import("@/features/customers/actions");
const meta = await import("@/features/integrations/meta/actions");

const UUID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("tenancy resolver read failures stay typed", () => {
  it.each([
    ["saveBusinessProfile", () => saveBusinessProfile({})],
    ["loadStaffRoster", () => staff.loadStaffRoster()],
    ["submitForReviewAction", () => submitForReviewAction({})],
    ["uploadVerificationDocument", () => uploadVerificationDocument(new FormData())],
    ["changeCustomerSegment", () => customers.changeCustomerSegment({})],
    ["startMetaConnect", () => meta.startMetaConnect()],
    ["connectMetaPages", () => meta.connectMetaPages({})],
    ["disconnectMeta", () => meta.disconnectMeta({ connectionId: UUID })],
    ["publishMetaCampaign", () => meta.publishMetaCampaign({})],
  ])("%s resolves to { ok: false } with the generic message", async (_name, call) => {
    const result = await call();

    expect(result).toMatchObject({
      ok: false,
      message: "Something went wrong on our side. Please try again.",
    });
  });
});
