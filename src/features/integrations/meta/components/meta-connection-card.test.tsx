import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The server actions are the module boundary; nothing here presses a button
// that would reach one, so a stub keeps the "use server" module out of a jsdom
// import graph.
vi.mock("../actions", () => ({
  startMetaConnect: vi.fn(),
  connectMetaPages: vi.fn(),
  disconnectMeta: vi.fn(),
}));

import { MetaConnectionCard } from "./meta-connection-card";
import type { MetaConnectionView, MetaIntegrationView } from "../types";

function view(overrides: Partial<MetaIntegrationView> = {}): MetaIntegrationView {
  return {
    configured: true,
    storageReady: true,
    canManage: true,
    connections: [],
    ...overrides,
  };
}

function connection(overrides: Partial<MetaConnectionView> = {}): MetaConnectionView {
  return {
    id: "cccccccc-1111-4111-8111-111111111111",
    status: "connected",
    externalAccountId: "1001",
    externalAccountName: "Kape Cebu",
    scopes: ["pages_show_list", "read_insights"],
    tokenExpiresAt: "2026-09-24T00:00:00.000Z",
    lastSyncedAt: null,
    error: null,
    connectedAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

function renderCard(props: Partial<React.ComponentProps<typeof MetaConnectionCard>> = {}) {
  return render(
    <MetaConnectionCard
      view={props.view ?? view()}
      outcome={props.outcome ?? null}
      selectionId={props.selectionId ?? null}
      selectablePages={props.selectablePages ?? []}
    />,
  );
}

describe("when the integration is dormant", () => {
  // META_APP_ID and META_APP_SECRET do not exist yet, so this is the state the
  // card is actually in today, in every environment.

  it("renders a clear, non-alarming not-available panel and NO connect button", () => {
    renderCard({ view: view({ configured: false }) });

    expect(screen.getByText("Not available yet")).toBeInTheDocument();
    expect(screen.getByText(/still going through review/i)).toBeInTheDocument();
    // The whole point: no button that would open a broken consent dialog.
    expect(screen.queryByRole("button", { name: /connect/i })).not.toBeInTheDocument();
  });

  it("does not present itself as an error", () => {
    renderCard({ view: view({ configured: false }) });
    // Nothing is wrong; something is simply not switched on.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("still explains what the feature is, so the card is not a mystery", () => {
    renderCard({ view: view({ configured: false }) });
    expect(screen.getByText(/Connect your Facebook Page/i)).toBeInTheDocument();
  });

  it("distinguishes missing app credentials from missing token storage", () => {
    // Different missing variable, different fix. A support ticket that says
    // "not configured" for both is a ticket nobody can act on.
    renderCard({ view: view({ configured: true, storageReady: false }) });
    expect(screen.getByText(/Secure storage for connected accounts/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect/i })).not.toBeInTheDocument();
  });

  it("still lists an existing connection when the credentials were removed", () => {
    // Credentials can be pulled from an environment while rows remain, and a
    // merchant whose connection exists is entitled to see it.
    renderCard({
      view: view({ configured: false, connections: [connection()] }),
    });
    expect(screen.getByText("Kape Cebu")).toBeInTheDocument();
  });
});

describe("when the integration is live", () => {
  it("offers a connect button with nothing connected", () => {
    renderCard();
    expect(screen.getByRole("button", { name: "Connect Facebook Page" })).toBeInTheDocument();
    expect(screen.queryByText("Not available yet")).not.toBeInTheDocument();
  });

  it("renders a connected Page with its status and granted permissions", () => {
    renderCard({ view: view({ connections: [connection()] }) });

    expect(screen.getByText("Kape Cebu")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/pages_show_list, read_insights/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    // Adding another Page stays possible.
    expect(screen.getByRole("button", { name: "Connect another Page" })).toBeInTheDocument();
  });

  it("PROMPTS A RECONNECT when the connection is expired", () => {
    renderCard({ view: view({ connections: [connection({ status: "expired" })] }) });

    expect(screen.getByText("Needs reconnecting")).toBeInTheDocument();
    expect(screen.getByText(/access we were given has expired/i)).toBeInTheDocument();
  });

  it("PROMPTS A RECONNECT when the grant was revoked at Meta", () => {
    renderCard({ view: view({ connections: [connection({ status: "revoked" })] }) });

    expect(screen.getByText("Access removed")).toBeInTheDocument();
    expect(screen.getByText(/removed on Facebook/i)).toBeInTheDocument();
  });

  it("does NOT prompt a reconnect for an error status", () => {
    // An error is our problem or Meta's. Telling a merchant to re-grant
    // permissions whenever anything looks wrong trains exactly the habit a
    // phishing flow relies on.
    renderCard({
      view: view({ connections: [connection({ status: "error", error: "Meta rejected a read." })] }),
    });

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Meta rejected a read.")).toBeInTheDocument();
    expect(screen.queryByText(/Reconnect to bring insights back/i)).not.toBeInTheDocument();
  });

  it("hides the buttons from a role that cannot manage connections", () => {
    renderCard({ view: view({ canManage: false, connections: [connection()] }) });

    expect(screen.queryByRole("button", { name: /connect/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("tells a non-managing role who can do it", () => {
    renderCard({ view: view({ canManage: false }) });
    expect(screen.getByText(/Ask an owner or manager/i)).toBeInTheDocument();
  });

  it("points at the screen where the figures and the composer actually are", () => {
    renderCard();
    expect(
      screen.getByText(
        "Your audience and engagement figures, and the announcement composer, are on the Marketing screen.",
      ),
    ).toBeInTheDocument();
  });

  it("CRITICAL: no longer promises that Giya never posts on the merchant's behalf", () => {
    // It DOES post now. `pages_manage_posts` is requested and the composer on
    // /business/marketing uses it. This card carried "Giya never posts on your
    // behalf" until that shipped, and a settings screen still saying it would
    // be the most consequential false claim in the product: a merchant who
    // read it would have no reason to expect anything on their Page.
    //
    // Asserted as an ABSENCE, permanently, so a well-meaning restoration of
    // reassuring copy cannot bring the lie back.
    renderCard();
    expect(screen.queryByText(/never posts on your behalf/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not part of this release/i)).not.toBeInTheDocument();
  });

  it("states the real boundary instead: a post happens only on a press", () => {
    // The pairing half. Deleting the false sentence without replacing it would
    // leave a merchant with no statement at all about whether we can post,
    // which is a different failure with the same cause.
    renderCard();
    expect(
      screen.getByText(
        "Connect your Facebook Page so Giya can read your audience and engagement figures. Giya posts to your Page only when you write an announcement and press Post.",
      ),
    ).toBeInTheDocument();
  });
});

describe("the page picker", () => {
  const pages = [
    { id: "1001", name: "Kape Cebu", category: "Coffee shop" },
    { id: "1002", name: "Kape Manila", category: null },
  ];

  it("lists the pages returned by the callback", () => {
    renderCard({ selectionId: "sel-1234567890123456", selectablePages: pages });

    expect(screen.getByText("Choose which Page belongs to this business.")).toBeInTheDocument();
    expect(screen.getByText("Kape Cebu")).toBeInTheDocument();
    expect(screen.getByText("Kape Manila")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });

  it("preselects the only Page when there is exactly one", () => {
    renderCard({
      selectionId: "sel-1234567890123456",
      selectablePages: [pages[0] as (typeof pages)[number]],
    });
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("button", { name: "Connect selected" })).toBeEnabled();
  });

  it("cannot be confirmed with nothing chosen", () => {
    renderCard({ selectionId: "sel-1234567890123456", selectablePages: pages });
    expect(screen.getByRole("button", { name: "Connect selected" })).toBeDisabled();
  });

  it("replaces the connect button while a choice is pending", () => {
    renderCard({ selectionId: "sel-1234567890123456", selectablePages: pages });
    expect(screen.queryByRole("button", { name: /Connect Facebook Page/ })).not.toBeInTheDocument();
  });
});

describe("callback outcomes", () => {
  it("explains a cancelled consent dialog without calling it an error", () => {
    renderCard({ outcome: "cancelled" });
    expect(screen.getByText(/You cancelled before granting access/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains a rejected state without naming the reason", () => {
    // The precise reason is a fact about our storage and stays in the log.
    renderCard({ outcome: "rejected" });
    expect(screen.getByText(/no longer valid/i)).toBeInTheDocument();
    expect(screen.queryByText(/business_mismatch|user_mismatch|unknown/)).not.toBeInTheDocument();
  });

  it("explains an account with no Pages as a fixable situation", () => {
    renderCard({ outcome: "no_pages" });
    expect(screen.getByText(/does not manage any Page yet/i)).toBeInTheDocument();
  });

  it("ignores an outcome flag it does not recognise", () => {
    // The query string is user-editable; an unknown value must not render
    // itself into the page.
    renderCard({ outcome: "<script>alert(1)</script>" });
    expect(screen.queryByText(/script/i)).not.toBeInTheDocument();
  });
});
