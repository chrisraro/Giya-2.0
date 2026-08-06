import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// ===========================================================================
// `/admin/flags`, the same "REAL DATA OR AN HONEST ABSENCE, NEVER A
// FIXTURE" property `queue-status-screen.test.tsx` guards, reproduced here
// for the flag registry: an empty list and a failed read must render
// differently, and a read-only (non-super_admin) session must see the
// toggle control disabled, not merely absent.
// ===========================================================================

vi.mock("./flags-actions", () => ({ toggleFeatureFlagAction: vi.fn() }));

import { FlagsScreen } from "./flags-screen";
import type { FeatureFlagItem } from "./types";

function flagItem(overrides: Partial<FeatureFlagItem> = {}): FeatureFlagItem {
  return {
    key: "ai_parse_assist",
    description: "LLM tier-3 fill-gap extraction for receipt parsing.",
    isEnabled: true,
    updatedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("FlagsScreen: the registry read", () => {
  // Mutant: render the empty state (or nothing) instead of the unavailable
  // banner when `flags` is null. A failed read of the platform's own kill
  // switches must not be readable as "there are no flags".
  it("renders an alert, not the empty state, when the read failed", () => {
    render(<FlagsScreen flags={null} canAct />);
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be read/i);
    expect(screen.queryByText("No flags are registered.")).not.toBeInTheDocument();
  });

  it("distinguishes a genuinely empty registry from a failed read", () => {
    const { rerender } = render(<FlagsScreen flags={[]} canAct />);
    expect(screen.getByText("No flags are registered.")).toBeInTheDocument();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);

    rerender(<FlagsScreen flags={null} canAct />);
    expect(screen.queryByText("No flags are registered.")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("renders each flag's key, description and on/off state", () => {
    render(
      <FlagsScreen
        flags={[
          flagItem({ key: "ai_parse_assist", isEnabled: true }),
          flagItem({ key: "ai_assistant", isEnabled: false }),
        ]}
        canAct
      />,
    );

    expect(screen.getByText("ai_parse_assist")).toBeInTheDocument();
    expect(screen.getByText("ai_assistant")).toBeInTheDocument();
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
  });
});

describe("FlagsScreen: who may act", () => {
  // Mutant: pass `canAct` straight through as `true` regardless of the prop,
  // or drop the prop from the toggle button entirely. Doc 31 section 1
  // scopes this screen to super_admin only; an `admin` or `support` session
  // must see the toggle control disabled, not merely absent - "assert the
  // refusal, not just the absence of a link".
  it("disables the toggle control and shows a read-only note for a non-super_admin session", () => {
    render(<FlagsScreen flags={[flagItem()]} canAct={false} />);

    expect(screen.getByRole("button", { name: /turn off/i })).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent(/read-only/i);
  });

  it("enables the toggle control for a super_admin session, with no read-only note", () => {
    render(<FlagsScreen flags={[flagItem()]} canAct />);

    expect(screen.getByRole("button", { name: /turn off/i })).toBeEnabled();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("labels the toggle button by the OPPOSITE of the flag's current state", () => {
    render(
      <FlagsScreen
        flags={[flagItem({ key: "ai_analytics", isEnabled: false })]}
        canAct
      />,
    );

    // An off flag's control offers to turn it ON, never repeats "turn off".
    expect(screen.getByRole("button", { name: /turn on/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /turn off/i })).not.toBeInTheDocument();
  });
});
