import { describe, expect, it } from "vitest";
import { isStampGridProgram, progressUnitLabel } from "./display";

describe("progressUnitLabel", () => {
  it("names each program type in the unit its target is actually set in", () => {
    // doc 35 section 3 step 11: points_target counts points, spend_amount
    // counts pesos (floor(total_centavos / 100)), the two count programs
    // count events.
    expect(progressUnitLabel("visit_count")).toBe("stamps");
    expect(progressUnitLabel("receipt_count")).toBe("receipts");
    expect(progressUnitLabel("points_target")).toBe("points");
    expect(progressUnitLabel("spend_amount")).toBe("pesos spent");
  });

  it("falls back to stamps for a program type with no ratified arithmetic", () => {
    // 0012 allows program_type='custom'; doc 35 defines no increment for it,
    // so 0078 stamps nothing and no such card can exist yet. If one ever
    // does, it reads as a stamp card rather than crashing the screen.
    expect(progressUnitLabel("custom")).toBe("stamps");
  });
});

describe("isStampGridProgram", () => {
  it("draws slots only for the count-based programs", () => {
    expect(isStampGridProgram("visit_count")).toBe(true);
    expect(isStampGridProgram("receipt_count")).toBe(true);
  });

  it("refuses a grid for programs whose target is not a number of events", () => {
    // A 500-point target is 500 circles otherwise.
    expect(isStampGridProgram("points_target")).toBe(false);
    expect(isStampGridProgram("spend_amount")).toBe(false);
    expect(isStampGridProgram("custom")).toBe(false);
  });
});
