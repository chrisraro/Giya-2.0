// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// THE SERVER ACTION SEAM. A SERVER ACTION IS DIRECTLY INVOCABLE.
// =============================================================================
//
// This file exists because three guards in actions.ts survived removal against
// the whole suite: the role gate, the tenancy pin, and the choice of role list.
// Every test that touched `publishMetaCampaign` did so through a `vi.mock` of
// it, so its 72 lines were never exercised.
//
// That is not a hygiene gap, and the page-level gate in
// app/(business)/business/(portal)/marketing/page.tsx is NOT a substitute for
// it. A "use server" export is an RPC endpoint reachable by anyone with a
// session and the action id; the page component it happens to be rendered
// beside is not in the call path at all. With the tenancy guard removed, a
// caller holding ANY `business_staff` row plus a connection UUID belonging to
// another tenant publishes into that tenant's public Facebook Page, because
// `readConnectionSecret`'s `business_id` predicate is then fed the forged
// value instead of the resolved one.
//
// The scope decision is what gave this action teeth. It now stands between a
// counter seat and the shop's public Page, so the guards get assertions.
//
// SHAPE: `resolveStaffContext` and the publishing service are the two seams
// that get stubbed, the same way features/businesses/staff/actions.test.ts
// stubs its session and its client. Everything between them runs for real,
// including the zod schema, so a wiring bug between this action and
// server/publishing.ts shows up here.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  resolveStaffContext: vi.fn(),
  publishCampaignToMeta: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/features/businesses/server/resolve-owner-business", () => ({
  resolveStaffContext: mocks.resolveStaffContext,
  BUSINESS_ROLES: ["owner", "manager", "marketing", "staff"],
}));

vi.mock("./server/publishing", () => ({
  publishCampaignToMeta: mocks.publishCampaignToMeta,
}));

// The three CONNECTION actions in this module import service.ts, which reaches
// a Supabase client at module scope. Stubbed so importing actions.ts does not
// require a server env; nothing in this file exercises those three, and they
// have their own suites.
vi.mock("./server/service", () => ({
  startConnect: vi.fn(),
  connectPages: vi.fn(),
  disconnect: vi.fn(),
  callbackUrl: vi.fn(),
  completeCallback: vi.fn(),
  listSelectable: vi.fn(),
  loadIntegrationView: vi.fn(),
  markDeauthorized: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/headers", () => ({ headers: async () => new Map() }));

const { publishMetaCampaign } = await import("./actions");

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-1111-4111-8111-111111111111";
const CONNECTION = "cccccccc-1111-4111-8111-111111111111";
/** A connection UUID belonging to somebody else's tenant. */
const OTHER_TENANTS_CONNECTION = "dddddddd-1111-4111-8111-111111111111";

/**
 * Doc 32 section 11.1's composer audience, typed out by hand.
 *
 * NOT imported from ./roles. The whole job of this literal is to be able to
 * disagree with that module, and a value read from the code under test cannot.
 */
const MARKETING_ROLES = ["owner", "manager", "marketing"];

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: CONNECTION,
    message: "Double points all weekend at Kape Cebu.",
    linkUrl: "https://giya.ph/b/kape-cebu",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveStaffContext.mockResolvedValue({
    businessId: BUSINESS,
    userId: USER,
    role: "marketing",
  });
  mocks.publishCampaignToMeta.mockResolvedValue({ ok: true, postId: "1001_9999" });
});

describe("the role gate on publishMetaCampaign", () => {
  it("CRITICAL: asks for the marketing roles, not the settings pair", async () => {
    // BUSINESS_SETTINGS_ROLES is ["owner","manager"] and is used by the three
    // connection actions in this same module. Swapping the two lists here is a
    // one-word edit that locks the marketing seat out of the one screen it
    // exists for, and nothing else in the suite would notice.
    await publishMetaCampaign(validInput());

    expect(mocks.resolveStaffContext).toHaveBeenCalledTimes(1);
    expect(mocks.resolveStaffContext).toHaveBeenCalledWith(MARKETING_ROLES);
  });

  it("CRITICAL: refuses a caller the role gate rejected, and never reaches Meta", async () => {
    // `resolveStaffContext` answers null for a member whose role is outside
    // the list, which today is the `staff` counter seat. The refusal must
    // happen BEFORE anything touches a connection: a server action is an
    // endpoint, so this is the only thing standing between that seat and the
    // shop's public Page.
    mocks.resolveStaffContext.mockResolvedValue(null);

    const result = await publishMetaCampaign(validInput());

    expect(result).toEqual({
      ok: false,
      message: "Only an owner, manager or marketing seat can post to a connected Page.",
    });
    expect(mocks.publishCampaignToMeta).not.toHaveBeenCalled();
  });

  it("resolves the role gate BEFORE it validates the payload", async () => {
    // Ordering matters for what a refused caller learns. Validating first
    // would let an unauthorized caller probe the schema by watching which
    // message comes back, and it would spend the parse on someone who is not
    // allowed to be here at all.
    mocks.resolveStaffContext.mockResolvedValue(null);

    const result = await publishMetaCampaign({ nonsense: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      "Only an owner, manager or marketing seat can post to a connected Page.",
    );
  });
});

describe("THE TENANCY PIN", () => {
  it("CRITICAL: sends the RESOLVED business id, never one from the payload", async () => {
    // The mutant this exists for: `businessId: input.businessId`. With it, a
    // caller holding any staff row publishes into whichever tenant they name.
    await publishMetaCampaign(
      validInput({ businessId: "99999999-1111-4111-8111-111111111111" }),
    );

    expect(mocks.publishCampaignToMeta).toHaveBeenCalledTimes(1);
    expect(mocks.publishCampaignToMeta.mock.calls[0]?.[0]).toMatchObject({
      businessId: BUSINESS,
    });
  });

  it("CRITICAL: a forged connection id is still scoped to the CALLER's business", async () => {
    // A connection UUID from another tenant is not rejected here, and it does
    // not need to be: it is handed to the service alongside the caller's OWN
    // business id, and `readConnectionSecret` pins both. The pair is what
    // makes the lookup find nothing. This asserts the pair travels intact.
    await publishMetaCampaign(validInput({ connectionId: OTHER_TENANTS_CONNECTION }));

    expect(mocks.publishCampaignToMeta.mock.calls[0]?.[0]).toMatchObject({
      businessId: BUSINESS,
      connectionId: OTHER_TENANTS_CONNECTION,
    });
  });

  it("audits against the caller's own identity and role, not the payload's", async () => {
    // 0022 denormalizes the role held AT THE TIME onto the audit row. Taking
    // either from the payload would let a caller sign somebody else's name to
    // a post on a merchant's Page.
    await publishMetaCampaign(validInput({ actorId: "someone-else", actorRole: "owner" }));

    expect(mocks.publishCampaignToMeta.mock.calls[0]?.[0]).toMatchObject({
      actorId: USER,
      actorRole: "marketing",
    });
  });
});

describe("the payload schema", () => {
  it("refuses an empty message with prose that names both fields", async () => {
    const result = await publishMetaCampaign(validInput({ message: "   " }));

    expect(result).toEqual({
      ok: false,
      message: "Write a message, and check the link is a full web address.",
    });
    expect(mocks.publishCampaignToMeta).not.toHaveBeenCalled();
  });

  it("refuses a connection id that is not a UUID", async () => {
    const result = await publishMetaCampaign(validInput({ connectionId: "not-a-uuid" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("Write a message, and check the link is a full web address.");
    expect(mocks.publishCampaignToMeta).not.toHaveBeenCalled();
  });

  it("refuses a link that is not a full web address", async () => {
    const result = await publishMetaCampaign(validInput({ linkUrl: "giya.ph/b/kape-cebu" }));

    expect(result.ok).toBe(false);
    expect(mocks.publishCampaignToMeta).not.toHaveBeenCalled();
  });

  it("refuses a message past the 5000 character bound", async () => {
    // An unbounded string here is an unbounded request body from one form post.
    const result = await publishMetaCampaign(validInput({ message: "x".repeat(5001) }));

    expect(result.ok).toBe(false);
    expect(mocks.publishCampaignToMeta).not.toHaveBeenCalled();
  });

  it("trims the message rather than posting the merchant's stray whitespace", async () => {
    await publishMetaCampaign(validInput({ message: "  Double points.  " }));

    expect(mocks.publishCampaignToMeta.mock.calls[0]?.[0]).toMatchObject({
      message: "Double points.",
    });
  });

  it("treats a cleared link field as no link, not as an empty one", async () => {
    // A merchant who clears the field is posting without a link, not making a
    // mistake. `link: ""` would reach the Graph API as a parameter.
    await publishMetaCampaign(validInput({ linkUrl: "" }));

    expect(mocks.publishCampaignToMeta.mock.calls[0]?.[0]).toMatchObject({
      linkUrl: undefined,
    });
  });

  it("refuses a payload that is not an object at all", async () => {
    const result = await publishMetaCampaign("not even an object");

    expect(result.ok).toBe(false);
    expect(mocks.publishCampaignToMeta).not.toHaveBeenCalled();
  });
});

describe("what the caller is told, and what is revalidated", () => {
  it("passes the service's refusal through verbatim", async () => {
    // The service owns the sentence, because it is the layer that knows WHICH
    // of the six degraded states applies. Replacing it here would disagree
    // with the capability panel rendered directly above the composer.
    mocks.publishCampaignToMeta.mockResolvedValue({
      ok: false,
      message:
        "Posting needs a Facebook permission this app has not been approved for yet. Nothing is wrong with your Page or your account.",
    });

    const result = await publishMetaCampaign(validInput());

    expect(result).toEqual({
      ok: false,
      message:
        "Posting needs a Facebook permission this app has not been approved for yet. Nothing is wrong with your Page or your account.",
    });
  });

  it("does NOT revalidate when the publish was refused", async () => {
    mocks.publishCampaignToMeta.mockResolvedValue({ ok: false, message: "no" });

    await publishMetaCampaign(validInput());
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("revalidates the marketing screen on success", async () => {
    // The capability panel above the composer reads a LIVE token state, so a
    // post that landed as a token expired must not leave a stale "ready".
    const result = await publishMetaCampaign(validInput());

    expect(result).toEqual({ ok: true, data: { postId: "1001_9999" } });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/business/marketing");
  });
});
