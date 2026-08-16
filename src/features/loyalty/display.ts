// Pure presentation vocabulary for loyalty cards. Deliberately NOT in
// server/repo.ts: the card screens mock that module in their own tests, and a
// presentation helper that disappears with the mock is a helper the screens
// cannot be tested against.

export type LoyaltyProgramType =
  | "visit_count"
  | "points_target"
  | "receipt_count"
  | "spend_amount"
  | "custom";

/**
 * How a card's progress reads to a consumer. `visit_count`/`receipt_count`
 * are literally stamps; the other two are measured in the unit their target
 * is set in (doc 35 section 3 step 11: `points_target` counts points,
 * `spend_amount` counts pesos).
 */
export function progressUnitLabel(programType: LoyaltyProgramType): string {
  switch (programType) {
    case "points_target":
      return "points";
    case "spend_amount":
      return "pesos spent";
    case "receipt_count":
      return "receipts";
    default:
      return "stamps";
  }
}

/**
 * Only count-based programs are drawn as a grid of stamp slots. A
 * `points_target` program with a target of 500 is a progress bar, not 500
 * circles.
 */
export function isStampGridProgram(programType: LoyaltyProgramType): boolean {
  return programType === "visit_count" || programType === "receipt_count";
}
