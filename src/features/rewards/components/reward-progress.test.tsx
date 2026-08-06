import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RewardProgress } from "./reward-progress";

// Doc 03's Key Finding 3: anchor the progress rail to the next reachable
// reward ("850 / 1,500 pts to Free Kape"), never to the catalogue maximum -
// this component only renders what `groupRewardsByBusiness`/`affordability`
// already anchored, so these tests are about copy and a11y, not arithmetic.

function fullLine() {
  return screen.getByText(
    (_content, element) =>
      element?.tagName.toLowerCase() === "p" && element.textContent === "850 / 1,500 pts to Free Kape",
  );
}

describe("RewardProgress", () => {
  it("renders the exact locale-formatted anchor copy", () => {
    render(<RewardProgress current={850} target={1500} rewardName="Free Kape" />);

    expect(fullLine()).toBeInTheDocument();
  });

  it("exposes a determinate, accessible progressbar at the right fraction", () => {
    render(<RewardProgress current={850} target={1500} rewardName="Free Kape" />);

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "57");
  });

  it("renders visibly at first paint (no class-triggered transition gating the fill)", () => {
    // Doc 16's binding rule: the fill's width must come from the initial
    // render, not from a mount-triggered class flip a headless render or a
    // hidden tab would never fire.
    const { container } = render(<RewardProgress current={0} target={1500} rewardName="Free Kape" />);

    const fill = container.querySelector('[style*="width"]');
    expect(fill).not.toBeNull();
    expect(fill).toHaveStyle({ width: "0%" });
  });

  it("clamps a full or over-target balance to a full bar without erroring", () => {
    render(<RewardProgress current={1600} target={1500} rewardName="Free Kape" />);

    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });
});
