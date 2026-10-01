import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/script", () => ({
  default: (props: { id: string; src: string }) => <script data-testid={props.id} data-src={props.src} />,
}));

import { FacebookPageEmbed } from "./facebook-page-embed";

const PAGE = "https://www.facebook.com/Meta";

describe("FacebookPageEmbed", () => {
  it("renders Meta's oEmbed html unmodified and loads the SDK", () => {
    render(<FacebookPageEmbed embed={{ status: "ok", html: '<div class="fb-page">oembed</div>' }} pageUrl={PAGE} />);

    expect(screen.getByTestId("facebook-page-embed").innerHTML).toBe('<div class="fb-page">oembed</div>');
    expect(screen.getByTestId("facebook-jssdk")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Visit Facebook Page" })).toHaveAttribute("href", PAGE);
  });

  it("falls back to the Page Plugin markup for the same URL while oEmbed Read is pending review", () => {
    const { container } = render(<FacebookPageEmbed embed={{ status: "pending_review" }} pageUrl={PAGE} />);

    const plugin = container.querySelector(".fb-page");
    expect(plugin).toHaveAttribute("data-href", PAGE);
    expect(screen.getByTestId("facebook-page-plugin")).toBeInTheDocument();
    expect(screen.queryByTestId("facebook-page-embed")).not.toBeInTheDocument();
    expect(screen.getByTestId("facebook-jssdk")).toBeInTheDocument();
  });

  it("attributes the SDK to Giya's app id when one is given", () => {
    render(<FacebookPageEmbed embed={{ status: "pending_review" }} pageUrl={PAGE} appId="849285887880230" />);

    expect(screen.getByTestId("facebook-jssdk").getAttribute("data-src")).toMatch(/&appId=849285887880230$/);
  });

  it("shows only the Page link, and no SDK, when the embed is unavailable", () => {
    const { container } = render(<FacebookPageEmbed embed={{ status: "unavailable" }} pageUrl={PAGE} />);

    expect(container.querySelector(".fb-page")).toBeNull();
    expect(screen.queryByTestId("facebook-jssdk")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Visit Facebook Page" })).toBeInTheDocument();
  });
});
