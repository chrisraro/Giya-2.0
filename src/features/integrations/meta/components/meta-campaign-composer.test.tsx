import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// THE PUBLISH AFFORDANCE, AND WHEN IT MUST NOT EXIST.
// =============================================================================
//
// This project has shipped a product stating a control it does not have three
// times: /suspended, the device list, the promotion card. A publish button on a
// token without `pages_manage_posts` would be the fourth, and it would fail on
// every single press, for a permission the merchant was never granted.
//
// So the assertions here are mostly about ABSENCE: no button, and the reason
// spelled out in full. The reason strings are typed as literals rather than
// imported from copy.ts, so they can disagree with it.

const actionsMock = vi.hoisted(() => ({ publishMetaCampaign: vi.fn() }));
vi.mock("../actions", () => ({
  startMetaConnect: vi.fn(),
  connectMetaPages: vi.fn(),
  disconnectMeta: vi.fn(),
  publishMetaCampaign: actionsMock.publishMetaCampaign,
}));

import { MetaCampaignComposer } from "./meta-campaign-composer";
import type { MetaConnectionCapability, MetaPublishView } from "../types";

const CONNECTION = "cccccccc-1111-4111-8111-111111111111";

function view(overrides: Partial<MetaPublishView> = {}): MetaPublishView {
  return {
    state: "pages",
    pages: [{ connectionId: CONNECTION, pageName: "Kape Cebu", capability: "ready" }],
    canManage: true,
    ...overrides,
  };
}

function withCapability(capability: MetaConnectionCapability): MetaPublishView {
  return view({ pages: [{ connectionId: CONNECTION, pageName: "Kape Cebu", capability }] });
}

const PUBLISH_BUTTON = { name: "Post to Facebook" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  actionsMock.publishMetaCampaign.mockResolvedValue({ ok: true, data: { postId: "1001_9999" } });
});

describe("no button when the deployment cannot publish at all", () => {
  it("says so and offers nothing when Meta is not configured here", () => {
    render(<MetaCampaignComposer view={view({ state: "not_configured", pages: [] })} />);

    expect(
      screen.getByText("Posting to a Facebook Page is not available on this deployment yet."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", PUBLISH_BUTTON)).not.toBeInTheDocument();
  });

  it("names credential storage separately, because it is a separate fix", () => {
    render(<MetaCampaignComposer view={view({ state: "storage_unavailable", pages: [] })} />);

    expect(
      screen.getByText(
        "Posting to a Facebook Page is not available yet: secure credential storage is not configured.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", PUBLISH_BUTTON)).not.toBeInTheDocument();
  });

  it("points an unconnected merchant at the screen that connects a Page", () => {
    render(<MetaCampaignComposer view={view({ state: "not_connected", pages: [] })} />);

    expect(
      screen.getByText("Connect a Facebook Page in Settings before posting a campaign announcement."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", PUBLISH_BUTTON)).not.toBeInTheDocument();
  });
});

describe("THE SCOPE GATE, on the screen (G2 section 2)", () => {
  it("CRITICAL: no publish button when the token lacks pages_manage_posts", async () => {
    render(<MetaCampaignComposer view={withCapability("scope_missing")} />);

    expect(screen.queryByRole("button", PUBLISH_BUTTON)).not.toBeInTheDocument();
    // Not a textarea either. A composer with no way to send is an invitation
    // to write something that goes nowhere.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("CRITICAL: says the permission is not approved yet, without blaming the merchant", () => {
    render(<MetaCampaignComposer view={withCapability("scope_missing")} />);

    // Full string. The second sentence is the half a paraphrase drops, and it
    // is the half that stops a merchant hunting through their Facebook
    // settings for a switch that is not there.
    expect(
      screen.getByText(
        "Posting needs a Facebook permission this app has not been approved for yet. Nothing is wrong with your Page or your account.",
      ),
    ).toBeInTheDocument();
  });

  it("CRITICAL: does NOT tell the merchant to reconnect over a missing scope", () => {
    // While the app is unreviewed, reconnecting yields exactly the same token
    // for anyone who is not an app admin, developer or tester. Offering it as
    // the remedy is a lie with a button attached.
    render(<MetaCampaignComposer view={withCapability("scope_missing")} />);

    expect(screen.queryByText(/Reconnect this Page/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reconnect/i })).not.toBeInTheDocument();
  });

  it("CRITICAL: the button IS there when the token carries the scope", async () => {
    // The pairing case. A component hard-wired to render nothing would satisfy
    // every assertion above while shipping a dead feature.
    render(<MetaCampaignComposer view={view()} />);

    expect(screen.getByRole("button", PUBLISH_BUTTON)).toBeInTheDocument();
    expect(screen.getByLabelText("Announcement")).toBeInTheDocument();
  });

  it("offers no button for an expired connection, and names reconnecting as the fix", () => {
    render(<MetaCampaignComposer view={withCapability("needs_reconnect")} />);

    expect(
      screen.getByText(
        "The access we were given has ended. Reconnect this Page in Settings before posting.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", PUBLISH_BUTTON)).not.toBeInTheDocument();
  });

  it("offers no button when Meta could not be asked, and claims nothing about permissions", () => {
    render(<MetaCampaignComposer view={withCapability("unavailable")} />);

    expect(
      screen.getByText(
        "Facebook is not responding right now, so posting is paused. Please try again in a few minutes.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", PUBLISH_BUTTON)).not.toBeInTheDocument();
    expect(screen.queryByText(/has not been approved/)).not.toBeInTheDocument();
  });

  it("offers no button and no remedy for a credential this build cannot open", () => {
    render(<MetaCampaignComposer view={withCapability("unreadable")} />);

    expect(
      screen.getByText(
        "Giya cannot open the stored credential for this Page. This one is ours to fix, and reconnecting will not help.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", PUBLISH_BUTTON)).not.toBeInTheDocument();
  });

  it("offers the composer for the Page that CAN publish and explains the one that cannot", () => {
    render(
      <MetaCampaignComposer
        view={view({
          pages: [
            { connectionId: "aaaa", pageName: "Kape Cebu", capability: "ready" },
            { connectionId: "bbbb", pageName: "Kape Manila", capability: "scope_missing" },
          ],
        })}
      />,
    );

    expect(screen.getByRole("button", PUBLISH_BUTTON)).toBeInTheDocument();
    expect(screen.getByText("Kape Manila")).toBeInTheDocument();
    expect(screen.getByText(/has not been approved for yet/)).toBeInTheDocument();
    // Only the publishable Page is offered as a target.
    expect(screen.queryByRole("radio", { name: "Kape Manila" })).not.toBeInTheDocument();
  });
});

describe("the composer itself", () => {
  it("cannot be submitted with an empty message", () => {
    render(<MetaCampaignComposer view={view()} />);
    expect(screen.getByRole("button", PUBLISH_BUTTON)).toBeDisabled();
  });

  it("sends the chosen Page, the message and the link to the action", async () => {
    render(<MetaCampaignComposer view={view()} />);

    fireEvent.change(screen.getByLabelText("Announcement"), {
      target: { value: "Double points all weekend." },
    });
    fireEvent.change(screen.getByLabelText("Link (optional)"), {
      target: { value: "https://giya.ph/b/kape-cebu" },
    });
    fireEvent.click(screen.getByRole("button", PUBLISH_BUTTON));

    await waitFor(() => {
      expect(actionsMock.publishMetaCampaign).toHaveBeenCalledWith({
        connectionId: CONNECTION,
        message: "Double points all weekend.",
        linkUrl: "https://giya.ph/b/kape-cebu",
      });
    });
  });

  it("confirms a successful post and clears the form", async () => {
    render(<MetaCampaignComposer view={view()} />);

    fireEvent.change(screen.getByLabelText("Announcement"), {
      target: { value: "Double points all weekend." },
    });
    fireEvent.click(screen.getByRole("button", PUBLISH_BUTTON));

    expect(await screen.findByText("Your announcement is live on Facebook.")).toBeInTheDocument();
    expect(screen.getByLabelText("Announcement")).toHaveValue("");
  });

  it("shows the server's refusal verbatim rather than a generic failure", async () => {
    // The server owns the sentence. A composer that replaced it with "Could
    // not post" would erase the one explanation the merchant can act on, and
    // would disagree with the panel above it about the same fact.
    actionsMock.publishMetaCampaign.mockResolvedValue({
      ok: false,
      message:
        "Posting needs a Facebook permission this app has not been approved for yet. Nothing is wrong with your Page or your account.",
    });
    render(<MetaCampaignComposer view={view()} />);

    fireEvent.change(screen.getByLabelText("Announcement"), {
      target: { value: "Double points all weekend." },
    });
    fireEvent.click(screen.getByRole("button", PUBLISH_BUTTON));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Posting needs a Facebook permission this app has not been approved for yet. Nothing is wrong with your Page or your account.",
    );
  });

  it("says plainly that nothing is posted without a press", () => {
    render(<MetaCampaignComposer view={view()} />);
    expect(screen.getByText(/Giya posts only when you press the button below/)).toBeInTheDocument();
  });

  it("hides the composer from a role that cannot post", () => {
    render(<MetaCampaignComposer view={view({ canManage: false })} />);

    expect(screen.queryByRole("button", PUBLISH_BUTTON)).not.toBeInTheDocument();
    expect(
      screen.getByText("Ask an owner, manager or marketing seat to post this."),
    ).toBeInTheDocument();
  });
});
