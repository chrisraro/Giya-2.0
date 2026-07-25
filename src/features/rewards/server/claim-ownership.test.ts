import { describe, expect, it } from "vitest";

import { assertClaimOwner } from "./claim-ownership";

// This predicate is the entire enforcement point for "claim owner only"
// endpoints: reward_claims RLS is a UNION of the consumer-self policy and
// the staff-of-business policy (0012_campaigns.sql), so repo.getClaim can
// return a claim that is visible to the caller but not owned by them (e.g.
// a staff member reading a customer's claim). Thoroughly unit-tested here
// since the route itself only exercises it through mocks.

describe("assertClaimOwner", () => {
  it("returns true when the claim's consumerId matches the caller", () => {
    expect(assertClaimOwner({ consumerId: "user-1" }, "user-1")).toBe(true);
  });

  it("returns false when the claim belongs to a different consumer", () => {
    expect(assertClaimOwner({ consumerId: "user-1" }, "user-2")).toBe(false);
  });

  it("returns false for a staff member of the business (RLS union case): staff id never equals consumer_id", () => {
    // Simulates exactly the hole this function closes: RLS's staff-select
    // policy let this row through, but the staff member is not the
    // consumer who claimed the reward.
    const claim = { consumerId: "consumer-abc" };
    const staffUserId = "staff-xyz";

    expect(assertClaimOwner(claim, staffUserId)).toBe(false);
  });

  it("is case-sensitive / exact-match only (no partial or normalized comparison)", () => {
    expect(assertClaimOwner({ consumerId: "User-1" }, "user-1")).toBe(false);
  });

  it("returns false when userId is an empty string and consumerId is not", () => {
    expect(assertClaimOwner({ consumerId: "user-1" }, "")).toBe(false);
  });

  it("ignores extra properties on the claim object (structural typing)", () => {
    const claim = {
      consumerId: "user-1",
      status: "claimed",
      businessId: "biz-1",
    };
    expect(assertClaimOwner(claim, "user-1")).toBe(true);
  });
});
