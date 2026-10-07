import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/script", () => ({
  default: (props: { id: string; src: string }) => <script data-testid={props.id} data-src={props.src} />,
}));

import { FacebookPageEmbed } from "./facebook-page-embed";

const PAGE = "https://www.facebook.com/Meta";

describe("FacebookPageEmbed (Facebook Page Plugin)", () => {
  it("renders the Page Plugin for the given Page and loads the SDK", () => {
    const { container } = render(<FacebookPageEmbed pageUrl={PAGE} />);

    expect(screen.getByTestId("facebook-page-plugin")).toBeInTheDocument();
    expect(container.querySelector(".fb-page")).toHaveAttribute("data-href", PAGE);
    expect(screen.getByTestId("facebook-jssdk")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Visit Facebook Page" })).toHaveAttribute("href", PAGE);
  });

  it("never injects raw HTML: the plugin is built from the allowlisted URL", () => {
    const { container } = render(<FacebookPageEmbed pageUrl={PAGE} />);

    // The old oEmbed path rendered Meta's HTML via dangerouslySetInnerHTML.
    expect(screen.queryByTestId("facebook-page-embed")).not.toBeInTheDocument();
    expect(container.querySelector("blockquote")).toHaveAttribute("cite", PAGE);
  });

  it("attributes the SDK to Giya's app id when one is given", () => {
    render(<FacebookPageEmbed pageUrl={PAGE} appId="849285887880230" />);

    expect(screen.getByTestId("facebook-jssdk").getAttribute("data-src")).toMatch(/&appId=849285887880230$/);
  });

  it("loads the SDK without an app id when none is configured", () => {
    render(<FacebookPageEmbed pageUrl={PAGE} appId={null} />);

    expect(screen.getByTestId("facebook-jssdk").getAttribute("data-src")).not.toContain("appId=");
  });
});
