import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getFacebookPageEmbed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/meta-oembed", () => ({
  getFacebookPageEmbed,
  getMetaAppIdForSdk: () => "849285887880230",
}));

import MetaReviewPage, { metadata } from "./page";

beforeEach(() => {
  getFacebookPageEmbed.mockReset();
});

describe("/meta-review", () => {
  it("asks oEmbed Read for Meta's own Facebook Page", async () => {
    getFacebookPageEmbed.mockResolvedValue({ status: "ok", html: "<div>meta</div>" });

    render(await MetaReviewPage());

    expect(getFacebookPageEmbed).toHaveBeenCalledWith("https://www.facebook.com/Meta");
    expect(screen.getByTestId("facebook-page-embed")).toHaveTextContent("meta");
    expect(screen.queryByTestId("pending-review-note")).not.toBeInTheDocument();
  });

  it("states plainly when the card is the Page Plugin fallback", async () => {
    getFacebookPageEmbed.mockResolvedValue({ status: "pending_review" });

    render(await MetaReviewPage());

    expect(screen.getByTestId("pending-review-note")).toHaveTextContent(/awaiting Meta App Review/);
    expect(screen.getByTestId("facebook-page-plugin")).toBeInTheDocument();
    // The intro must not claim oEmbed Read drew a card the Page Plugin drew.
    expect(screen.queryByText(/rendered from the embed HTML/)).not.toBeInTheDocument();
  });

  it("credits oEmbed Read only when it actually produced the card", async () => {
    getFacebookPageEmbed.mockResolvedValue({ status: "ok", html: "<div>meta</div>" });

    render(await MetaReviewPage());

    expect(screen.getByText(/rendered from the embed HTML our server retrieves/)).toBeInTheDocument();
  });

  it("is kept out of search indexes", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
