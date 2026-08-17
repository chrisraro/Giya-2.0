import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PromotionCard } from "./promotion-card";
import type { PublicPromotion } from "../server/repo";

// A promotion has NO in-app claim. Doc 34's surface table is explicit for both
// `promotion` [MVP] ("Card on business page + home 'Promos'; no in-app claim,
// shown at counter") and `discount` [V1] ("counter-honored"). The card used to
// render `redemptionHint` when the merchant had set one and nothing at all when
// they had not, so a consumer looking at a promotion had no way to learn there
// is no button to press. That is a system-level fact about how promotions work,
// not a per-merchant nicety, so the card states it either way.
//
// The literal below is repeated here ON PURPOSE. Importing the constant the
// component renders would make the expected value and the actual value the same
// value, and an assertion whose two sides come from one place cannot disagree
// with the code. This test is the second copy that has to be changed
// deliberately.
const COUNTER_CONTRACT =
  "No claim needed. Show this offer at the counter and the shop applies it.";

const CONTRACT_TESTID = "promotion-counter-contract";

function promotion(overrides: Partial<PublicPromotion> = {}): PublicPromotion {
  return {
    id: "promo-1",
    campaignId: "campaign-1",
    businessId: "business-1",
    name: "Merienda Madness",
    description: null,
    offerKind: "percent_off",
    percentOff: 20,
    amountOffCentavos: null,
    freebieText: null,
    terms: null,
    redemptionHint: null,
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

function contractText(): string {
  return screen.getByTestId(CONTRACT_TESTID).textContent ?? "";
}

describe("PromotionCard redemption contract", () => {
  it("CRITICAL: states the counter-honoured contract when the merchant set no hint", () => {
    render(<PromotionCard promotion={promotion()} />);

    // Full string, not a substring: this is fixed prose making a promise about
    // how an offer is redeemed, and a test that pins particular words does not
    // pin the claim those words make. "Show this offer at the counter" alone
    // would still pass if the sentence promising there is nothing to claim were
    // deleted.
    expect(contractText()).toBe(COUNTER_CONTRACT);
  });

  it("CRITICAL: still states it when the merchant DID set a hint", () => {
    render(
      <PromotionCard
        promotion={promotion({ redemptionHint: "Mention the code MERIENDA20." })}
      />,
    );

    expect(contractText()).toBe(COUNTER_CONTRACT);
  });

  it("keeps the merchant's hint as additional detail rather than a replacement", () => {
    render(
      <PromotionCard
        promotion={promotion({ redemptionHint: "Mention the code MERIENDA20." })}
      />,
    );

    expect(screen.getByText(/Mention the code MERIENDA20\./)).toBeInTheDocument();
    expect(contractText()).toBe(COUNTER_CONTRACT);
  });

  // EVERY offer family `getOfferBadgeText` can render, not just the two that
  // happen to be percentage-shaped. `freebie` is as live as the others and is
  // the one a "counter-honoured" claim is easiest to quietly drop from, because
  // a free item feels less like a price cut than the other two and the suite
  // stayed green without it.
  it.each([
    { family: "percent_off", overrides: { offerKind: "percent_off", percentOff: 20 } },
    {
      family: "amount_off",
      overrides: { offerKind: "amount_off", percentOff: null, amountOffCentavos: 5000 },
    },
    {
      family: "freebie",
      overrides: { offerKind: "freebie", percentOff: null, freebieText: "a cup of taho" },
    },
    // Neither column set. getOfferBadgeText falls through to "PROMO", and the
    // contract is no less true for an offer the merchant described only in prose.
    { family: "unspecified", overrides: { offerKind: "promotion", percentOff: null } },
  ])(
    "CRITICAL: states it for a $family offer, which is counter-honored the same way",
    ({ overrides }) => {
      render(<PromotionCard promotion={promotion(overrides)} />);

      expect(contractText()).toBe(COUNTER_CONTRACT);
    },
  );

  it("uses no em-dash, which this codebase bans in consumer copy", () => {
    render(<PromotionCard promotion={promotion()} />);

    expect(contractText()).not.toContain("—");
  });

  it("never tells the consumer they cannot do something", () => {
    render(<PromotionCard promotion={promotion()} />);

    // Copy rule: never accuse the consumer. "You cannot claim this" states the
    // same fact by blaming the reader for wanting to.
    expect(contractText().toLowerCase()).not.toContain("you can");
    expect(contractText().toLowerCase()).not.toContain("cannot");
  });
});
