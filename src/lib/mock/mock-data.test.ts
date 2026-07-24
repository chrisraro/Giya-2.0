import { describe, expect, it } from "vitest";
import { MOCK_BALANCES } from "./consumer";
import { MOCK_KPIS, MOCK_WEEK_VISITS } from "./business";

describe("consumer mock data", () => {
  it("includes a Kape Diaria balance with 1250 points and 3/5 stamps", () => {
    const kapeDiaria = MOCK_BALANCES.find((b) => b.businessName === "Kape Diaria");
    expect(kapeDiaria).toBeDefined();
    expect(kapeDiaria?.points).toBe(1250);
    expect(kapeDiaria?.stampsEarned).toBe(3);
    expect(kapeDiaria?.stampsTarget).toBe(5);
  });
});

describe("business mock data", () => {
  it("has exactly 4 KPIs with the exact labels and values", () => {
    expect(MOCK_KPIS).toHaveLength(4);
    expect(MOCK_KPIS).toEqual([
      { label: "Visits this week", value: "128", delta: "+12% vs last week" },
      { label: "Points issued", value: "4,320", delta: "+8%" },
      { label: "Redemptions", value: "37", delta: "+5" },
      { label: "New customers", value: "24", delta: "+3" },
    ]);
  });

  it("has 7 days of week visits", () => {
    expect(MOCK_WEEK_VISITS).toHaveLength(7);
    expect(MOCK_WEEK_VISITS.map((d) => d.day)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    for (const d of MOCK_WEEK_VISITS) {
      expect(d.value).toBeGreaterThanOrEqual(12);
      expect(d.value).toBeLessThanOrEqual(28);
    }
  });
});
