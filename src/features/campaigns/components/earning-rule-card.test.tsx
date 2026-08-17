import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EarningRuleCard } from "./earning-rule-card";
import type { PointsRuleRow } from "../server/types";

// The merchant half of T4.6. `ScanPreview` and `previewReceiptPointsAction`
// were both correct, both tested, and reachable from nowhere; the plan named
// two surfaces for them and this is the second one, "a 'test a receipt' preview
// on the rules card".
//
// Every assertion goes through the CARD. Rendering <ScanPreview /> on its own
// passed for the entire time it was orphaned, and the number is produced by
// typing a real amount so that a mount which forgets the rule prop, or hands it
// the SAVED rule instead of the one in the form, cannot survive either.

vi.mock("server-only", () => ({}));

const AMOUNT = "Receipt total in pesos";
const RATE = "1 point per (peso)";

function baseRule(overrides: Partial<PointsRuleRow> = {}): PointsRuleRow {
  return {
    id: "rule-1",
    business_id: "biz-1",
    campaign_id: null,
    kind: "base",
    rule_type: "amount_rate",
    rate_centavos_per_point: 100,
    fixed_points: null,
    tiers: null,
    multiplier: null,
    bonus_points: null,
    conditions: null,
    rounding: "floor",
    is_active: true,
    ...overrides,
  } as PointsRuleRow;
}

async function setValue(label: string, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  });
}

function estimate(): string | null {
  return screen.queryByLabelText(AMOUNT) === null ? null : screen.getByText(/pts$/).textContent;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EarningRuleCard receipt preview", () => {
  it("CRITICAL: the card mounts the preview and computes under the rate in the form", async () => {
    render(<EarningRuleCard baseRule={null} onSave={vi.fn()} />);

    await setValue(RATE, "50");
    await setValue(AMOUNT, "300");

    // ₱300 at 1 point per ₱50 is 6. The preview action's unsupplied-rate
    // fallback is 1 point per peso and would say 300, so this figure is only
    // reachable if the card handed it the rate the merchant typed.
    expect(screen.getByText("~6 pts")).toBeInTheDocument();
  });

  it("CRITICAL: previews the rule being EDITED, not the one already saved", async () => {
    render(<EarningRuleCard baseRule={baseRule({ rate_centavos_per_point: 100 })} onSave={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await setValue(RATE, "50");
    await setValue(AMOUNT, "300");

    // 300 would be the saved rule's answer (1 point per ₱1); 6 is the unsaved
    // one's (1 point per ₱50).
    expect(screen.getByText("~6 pts")).toBeInTheDocument();
  });

  it("follows the rounding mode the merchant has selected", async () => {
    render(<EarningRuleCard baseRule={null} onSave={vi.fn()} />);

    await setValue(RATE, "7");
    await setValue("Rounding", "ceil");
    await setValue(AMOUNT, "100");

    // 10000 / 700 = 14.28..., which floors to 14 and ceils to 15.
    expect(screen.getByText("~15 pts")).toBeInTheDocument();
  });

  // The amount is NOT retyped. A figure that only refreshes on a keystroke in
  // the peso box goes stale the moment the merchant edits the rate, and it goes
  // stale by staying on screen looking exactly as authoritative as before.
  it("CRITICAL: re-estimates the amount already on screen when the rate changes under it", async () => {
    render(<EarningRuleCard baseRule={null} onSave={vi.fn()} />);

    await setValue(RATE, "50");
    await setValue(AMOUNT, "300");
    expect(screen.getByText("~6 pts")).toBeInTheDocument();

    await setValue(RATE, "10");
    expect(screen.getByText("~30 pts")).toBeInTheDocument();
  });

  it("offers nothing to test until there is a valid rate to test against", async () => {
    render(<EarningRuleCard baseRule={null} onSave={vi.fn()} />);

    expect(estimate()).toBeNull();

    await setValue(RATE, "not a peso amount");
    expect(estimate()).toBeNull();
  });

  it("CRITICAL: offers no peso field for a fixed-per-visit rule, where the amount changes nothing", async () => {
    render(<EarningRuleCard baseRule={null} onSave={vi.fn()} />);

    await setValue(RATE, "50");
    expect(screen.getByLabelText(AMOUNT)).toBeInTheDocument();

    await setValue("Rule type", "fixed_per_visit");

    // A peso box that cannot change the answer is a control that lies about
    // what the rule does.
    expect(screen.queryByLabelText(AMOUNT)).not.toBeInTheDocument();
  });

  it("CRITICAL: keeps the preview outside the rule form, so Enter cannot save a draft rule", async () => {
    const onSave = vi.fn();
    render(<EarningRuleCard baseRule={null} onSave={onSave} />);

    await setValue(RATE, "50");

    // A number input inside a <form> submits it on Enter. The merchant pressing
    // Enter after typing a test amount would save the rule they were still
    // deciding on.
    expect(screen.getByLabelText(AMOUNT).closest("form")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });
});
