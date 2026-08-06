import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// /invite/[token] - the rendered-page seam. service.ts's own tests already
// cover previewInvite's/acceptInvite's logic; this file is about what the
// PAGE does with a given preview + session combination, which is where the
// three human-facing branches (invalid/expired, no session, wrong account,
// matching account) actually live for a reader to see.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  previewInvite: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("@/features/businesses/staff/server/service", () => ({
  previewInvite: mocks.previewInvite,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));

// The accept button is a client component with its own "use server" action
// import chain (actions.ts -> service.ts -> real Supabase clients); mocking
// it out keeps this file testing the PAGE's branch selection, not
// re-exercising the write path service.test.ts already covers.
vi.mock("@/features/businesses/staff/components/invite-accept", () => ({
  InviteAccept: ({ token }: { token: string }) => (
    <button type="button">Accept invite (token {token})</button>
  ),
}));

const InvitePage = (await import("./page")).default;

const TOKEN = "tok_live";

async function renderInvite(): Promise<void> {
  render(await InvitePage({ params: Promise.resolve({ token: TOKEN }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("an invalid or expired token", () => {
  it("shows the expired message and never renders the accept control", async () => {
    mocks.previewInvite.mockResolvedValue({
      ok: false,
      code: "INVITE_EXPIRED",
      message: "This invite has expired. Ask the business to send a new one.",
    });

    await renderInvite();

    expect(screen.getByText("This invite has expired")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Accept invite/i })).not.toBeInTheDocument();
  });

  it("shows an invalid-link message for an unknown/consumed token", async () => {
    mocks.previewInvite.mockResolvedValue({
      ok: false,
      code: "INVITE_INVALID",
      message: "This invite link is no longer valid.",
    });

    await renderInvite();

    expect(screen.getByText(/isn't valid/i)).toBeInTheDocument();
  });
});

describe("a live token, signed out", () => {
  beforeEach(() => {
    mocks.previewInvite.mockResolvedValue({
      ok: true,
      data: { businessName: "Kape Diaria", role: "staff", invitedEmail: "invitee@example.com" },
    });
    mocks.getUser.mockResolvedValue({ data: { user: null } });
  });

  it("never renders the accept control for a signed-out visitor", async () => {
    // Mutant this catches: rendering <InviteAccept> unconditionally (skipping
    // the session check) would let a signed-out visitor's click reach the
    // action with no identity behind it at all.
    await renderInvite();

    expect(screen.queryByRole("button", { name: /Accept invite/i })).not.toBeInTheDocument();
  });

  it("offers sign-in and sign-up, both carrying this invite as the return path", async () => {
    await renderInvite();

    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent(`/invite/${TOKEN}`)}`,
    );
    expect(screen.getByRole("link", { name: "Create account" })).toHaveAttribute(
      "href",
      `/signup?next=${encodeURIComponent(`/invite/${TOKEN}`)}`,
    );
  });

  it("names the invited address so a visitor knows which account to use", async () => {
    await renderInvite();

    expect(screen.getAllByText(/invitee@example\.com/).length).toBeGreaterThan(0);
  });
});

describe("a live token, signed in as a DIFFERENT account", () => {
  it("warns explicitly and does not render the accept control", async () => {
    // Mutant: comparing the wrong field, or omitting this branch, would let a
    // signed-in-as-someone-else visitor reach the accept button directly -
    // the true refusal is server-side (service.test.ts's WRONG_ACCOUNT
    // suite), but a UI that offers the button anyway is exactly the "hidden
    // button is not a control" anti-pattern the brief calls out.
    mocks.previewInvite.mockResolvedValue({
      ok: true,
      data: { businessName: "Kape Diaria", role: "staff", invitedEmail: "invitee@example.com" },
    });
    mocks.getUser.mockResolvedValue({ data: { user: { id: "u1", email: "someone-else@example.com" } } });

    await renderInvite();

    expect(screen.getByRole("alert")).toHaveTextContent(/signed in as someone-else@example\.com/i);
    expect(screen.queryByRole("button", { name: /Accept invite/i })).not.toBeInTheDocument();
  });
});

describe("a live token, signed in as the matching account", () => {
  it("renders the accept control", async () => {
    mocks.previewInvite.mockResolvedValue({
      ok: true,
      data: { businessName: "Kape Diaria", role: "staff", invitedEmail: "invitee@example.com" },
    });
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "u1", email: "invitee@example.com" } },
    });

    await renderInvite();

    expect(screen.getByRole("button", { name: /Accept invite/i })).toBeInTheDocument();
  });
});
