import { describe, expect, it } from "vitest";

import { affordability } from "./affordability";

// ===========================================================================
// The rewards screen's core bug (doc 03's Key Finding 3): it never reads a
// balance, so an unaffordable reward renders identically to an affordable one
// and fails with POINTS_INSUFFICIENT on tap. `affordability` is the pure
// function that decides, per reward, whether the caller can afford it and by
// how much they are short - and separately decides where the progress
// indicator anchors. Kept pure and DB-free so every case below is exhaustive
// and instant; the page/component only wire its output to markup.
// ===========================================================================

function reward(rewardId: string, name: string, pointsCost: number) {
  return { rewardId, name, pointsCost };
}

describe("affordability", () => {
  it("marks a reward affordable when the balance exceeds its cost", () => {
    const result = affordability(1000, [reward("r1", "Free latte", 500)]);

    expect(result.rewards).toEqual([{ rewardId: "r1", affordable: true, shortfall: 0 }]);
  });

  it("treats balance exactly equal to cost as affordable (the boundary)", () => {
    const result = affordability(500, [reward("r1", "Free latte", 500)]);

    expect(result.rewards[0]).toEqual({ rewardId: "r1", affordable: true, shortfall: 0 });
  });

  it("marks a reward unaffordable and states the exact shortfall", () => {
    const result = affordability(278, [reward("r1", "Free Kape", 1500)]);

    expect(result.rewards).toEqual([{ rewardId: "r1", affordable: false, shortfall: 1222 }]);
  });

  it("computes shortfall independently per reward", () => {
    const result = affordability(100, [
      reward("cheap", "Cheap", 150),
      reward("mid", "Mid", 300),
      reward("free", "Free", 50),
    ]);

    expect(result.rewards).toEqual([
      { rewardId: "cheap", affordable: false, shortfall: 50 },
      { rewardId: "mid", affordable: false, shortfall: 200 },
      { rewardId: "free", affordable: true, shortfall: 0 },
    ]);
  });

  it("anchors progress to the CHEAPEST unaffordable reward, never the catalogue maximum", () => {
    // Doc 03: McDonald's anchors to the top tier, so a 278/6000 balance reads
    // as a 4% bar and gets mocked. The fix is to anchor to the next reachable
    // reward instead.
    const result = affordability(850, [
      reward("expensive", "Combo meal", 6000),
      reward("mid", "Free Kape", 1500),
      reward("cheap", "Iced tea", 900),
    ]);

    expect(result.progress).toEqual({
      rewardId: "cheap",
      rewardName: "Iced tea",
      current: 850,
      target: 900,
    });
  });

  it("picks the cheapest unaffordable reward even when it is not first in the list", () => {
    const result = affordability(850, [
      reward("mid", "Free Kape", 1500),
      reward("cheap", "Iced tea", 900),
    ]);

    expect(result.progress?.rewardId).toBe("cheap");
  });

  it("has no progress anchor when every reward is already affordable", () => {
    const result = affordability(5000, [reward("r1", "Free latte", 500), reward("r2", "Fries", 300)]);

    expect(result.progress).toBeNull();
  });

  it("has no progress anchor when there are no rewards at all", () => {
    const result = affordability(0, []);

    expect(result.rewards).toEqual([]);
    expect(result.progress).toBeNull();
  });

  it("anchors progress correctly even at zero balance", () => {
    const result = affordability(0, [reward("r1", "Free Kape", 1500)]);

    expect(result.progress).toEqual({ rewardId: "r1", rewardName: "Free Kape", current: 0, target: 1500 });
  });
});
