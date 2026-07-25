import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BalanceDTO } from "@/features/rewards/types";

// The wallet's balance rows have always ended in a `chevron_right`, the
// universal promise that tapping goes somewhere, and they went nowhere.
// Meanwhile `/b/[slug]` - a real, working public business page - had no
// consumer entry point at all. These tests hold both ends of that fix.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getMyBalances: vi.fn(),
  listMyLedger: vi.fn(),
  listMyReceipts: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));

vi.mock("@/features/rewards/server/repo", () => ({
  getMyBalances: mocks.getMyBalances,
  listMyLedger: mocks.listMyLedger,
}));

vi.mock("@/features/receipts/server/repo", () => ({
  listMyReceipts: mocks.listMyReceipts,
}));

// The live receipt strip is a Realtime client island with its own test file;
// stub it so this file is about the balance rows.
vi.mock("@/features/receipts/components/wallet-receipt-activity", () => ({
  WALLET_RECEIPT_LIMIT: 3,
  WalletReceiptActivity: () => null,
}));

const WalletPage = (await import("./page")).default;

function balance(overrides: Partial<BalanceDTO> = {}): BalanceDTO {
  return {
    businessId: "biz-1",
    businessName: "Kape Diaria",
    businessSlug: "kape-diaria",
    pointsBalance: 1250,
    lifetimePoints: 4000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.listMyLedger.mockResolvedValue([]);
  mocks.listMyReceipts.mockResolvedValue({ rows: [] });
  mocks.getMyBalances.mockResolvedValue([balance()]);
});

describe("wallet balance rows", () => {
  it("CRITICAL: the chevron keeps its promise and links to the shop's page", async () => {
    render(await WalletPage());

    const row = screen.getByRole("link", { name: /Kape Diaria/ });
    expect(row).toHaveAttribute("href", "/b/kape-diaria");
    expect(row).toHaveTextContent("1,250 pts");
  });

  it("renders a non-interactive card when the slug did not resolve", async () => {
    // getMyBalances answers "" for the slug when the businesses read missed.
    // A link to `/b/` is a link to nowhere.
    mocks.getMyBalances.mockResolvedValue([balance({ businessSlug: "" })]);

    render(await WalletPage());

    expect(screen.queryByRole("link", { name: /Kape Diaria/ })).not.toBeInTheDocument();
    expect(screen.getByText("Kape Diaria")).toBeInTheDocument();
  });

  it("shows the empty state instead of rows when there are no balances", async () => {
    mocks.getMyBalances.mockResolvedValue([]);

    render(await WalletPage());

    expect(screen.getByText("No balances yet")).toBeInTheDocument();
  });
});
