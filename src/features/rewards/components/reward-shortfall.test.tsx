import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RewardShortfall } from "./reward-shortfall";

// The number lives in its own <span> so it can carry a different (readable,
// non-muted) style than the surrounding label - see the component doc. That
// splits the sentence across elements, which testing-library's default text
// matcher does not concatenate, so these tests match on the paragraph's own
// textContent instead of the plain string.
function fullSentence() {
  return screen.getByText(
    (_content, element) => element?.tagName.toLowerCase() === "p" && element.textContent === "1,222 points to go",
  );
}

describe("RewardShortfall", () => {
  it("renders the exact, locale-formatted copy doc 03 asks for", () => {
    render(<RewardShortfall shortfall={1222} />);

    expect(fullSentence()).toBeInTheDocument();
  });

  it("never renders the qualitative refusal copy", () => {
    render(<RewardShortfall shortfall={1222} />);

    expect(screen.queryByText(/insufficient/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not enough/i)).not.toBeInTheDocument();
  });

  it("keeps the number at readable weight (on-surface, not muted) inside a muted label", () => {
    render(<RewardShortfall shortfall={1222} />);

    const number = screen.getByText("1,222");
    expect(number).toHaveClass("text-on-surface");
    expect(number).toHaveClass("font-mono");

    expect(fullSentence()).toHaveClass("text-on-surface-variant");
  });
});
