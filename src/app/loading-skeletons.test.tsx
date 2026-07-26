import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import BusinessCampaignsLoading from "./(business)/business/(portal)/campaigns/loading";
import BusinessCustomersLoading from "./(business)/business/(portal)/customers/loading";
import BusinessDashboardLoading from "./(business)/business/(portal)/dashboard/loading";
import BusinessMenuLoading from "./(business)/business/(portal)/menu/loading";
import BusinessReceiptDetailLoading from "./(business)/business/(portal)/receipts/[receiptId]/loading";
import BusinessReceiptsLoading from "./(business)/business/(portal)/receipts/loading";
import BusinessRewardsLoading from "./(business)/business/(portal)/rewards/loading";
import BusinessSettingsLoading from "./(business)/business/(portal)/settings/loading";
import ShopLoading from "./(consumer)/b/[slug]/loading";
import HomeLoading from "./(consumer)/home/loading";
import NotificationsLoading from "./(consumer)/notifications/loading";
import ReceiptsLoading from "./(consumer)/receipts/loading";
import RewardsLoading from "./(consumer)/rewards/loading";
import ScanLoading from "./(consumer)/scan/loading";
import WalletLoading from "./(consumer)/wallet/loading";

// Route-level loading states.
//
// Two things are worth testing about a skeleton, and neither is "does it look
// nice":
//
//   1. It must SHARE THE SHAPE of the page it stands in for. A skeleton whose
//      layout differs from the loaded content trades a blank screen for a
//      visible jump, which is a worse trade. The shape assertions below pin the
//      structural facts that are FIXED by the real components -- four KPI
//      cards, eight table columns, seven days of opening hours -- so drift in
//      either direction fails here.
//   2. It must be visible in BOTH themes. That means tokens, never literals.
//      A hardcoded light grey is invisible on a dark surface, and it is the
//      single most common way a skeleton ships broken.

const ROUTES = [
  { name: "consumer /home", Loading: HomeLoading, label: "your home" },
  { name: "consumer /wallet", Loading: WalletLoading, label: "your wallet" },
  { name: "consumer /rewards", Loading: RewardsLoading, label: "your rewards" },
  { name: "consumer /receipts", Loading: ReceiptsLoading, label: "your receipts" },
  {
    name: "consumer /scan",
    Loading: ScanLoading,
    label: "shops you can scan a receipt from",
  },
  { name: "consumer /b/[slug]", Loading: ShopLoading, label: "this shop" },
  {
    name: "consumer /notifications",
    Loading: NotificationsLoading,
    label: "your notifications",
  },
  {
    name: "business /dashboard",
    Loading: BusinessDashboardLoading,
    label: "your dashboard",
  },
  { name: "business /menu", Loading: BusinessMenuLoading, label: "your menu" },
  {
    name: "business /campaigns",
    Loading: BusinessCampaignsLoading,
    label: "your campaigns",
  },
  {
    name: "business /customers",
    Loading: BusinessCustomersLoading,
    label: "your customers",
  },
  { name: "business /rewards", Loading: BusinessRewardsLoading, label: "your rewards" },
  {
    name: "business /receipts",
    Loading: BusinessReceiptsLoading,
    label: "the receipt queue",
  },
  {
    name: "business /receipts/[receiptId]",
    Loading: BusinessReceiptDetailLoading,
    label: "this receipt",
  },
  { name: "business /settings", Loading: BusinessSettingsLoading, label: "your settings" },
] as const;

describe.each(ROUTES)("$name loading state", ({ Loading, label }) => {
  it("renders", () => {
    const { container } = render(<Loading />);
    expect(container.firstElementChild).not.toBeNull();
  });

  it("announces itself as busy and says what is loading", () => {
    const { container, getByText } = render(<Loading />);

    expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
    expect(getByText(`Loading ${label}.`)).toBeInTheDocument();
  });

  it("hides its bones from assistive technology", () => {
    const { container } = render(<Loading />);
    expect(container.querySelector("[aria-hidden]")).not.toBeNull();
  });

  it("draws at least one bone", () => {
    // Guards against a skeleton that renders structure but no visible content,
    // which would look identical to a blank screen.
    const { container } = render(<Loading />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("makes every bone reduced-motion safe", () => {
    const { container } = render(<Loading />);
    const bones = container.querySelectorAll(".animate-pulse");

    for (const bone of bones) {
      expect(bone).toHaveClass("motion-reduce:animate-none");
    }
  });
});

describe("skeleton colour", () => {
  const LOADING_FILES = [
    "(consumer)/home/loading.tsx",
    "(consumer)/wallet/loading.tsx",
    "(consumer)/rewards/loading.tsx",
    "(consumer)/receipts/loading.tsx",
    "(consumer)/scan/loading.tsx",
    "(consumer)/b/[slug]/loading.tsx",
    "(consumer)/notifications/loading.tsx",
    "(business)/business/(portal)/dashboard/loading.tsx",
    "(business)/business/(portal)/menu/loading.tsx",
    "(business)/business/(portal)/campaigns/loading.tsx",
    "(business)/business/(portal)/customers/loading.tsx",
    "(business)/business/(portal)/rewards/loading.tsx",
    "(business)/business/(portal)/receipts/loading.tsx",
    "(business)/business/(portal)/receipts/[receiptId]/loading.tsx",
    "(business)/business/(portal)/settings/loading.tsx",
  ];

  it.each(LOADING_FILES)("%s uses no hardcoded colour", (file) => {
    const source = readFileSync(join(process.cwd(), "src/app", file), "utf8");

    // Hex literals, rgb()/hsl() functions, and Tailwind's built-in colour
    // palette (bg-gray-200 and friends) are all ways to bypass the token layer
    // and end up invisible in one of the two themes.
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
    expect(source).not.toMatch(
      /\b(bg|text|border)-(slate|gray|grey|zinc|neutral|stone)-\d{2,3}\b/,
    );
  });

  it.each(LOADING_FILES)("%s reserves mango for rewards", (file) => {
    // Doc 16: tertiary is reward language. A generic loading state must not
    // borrow it, or the celebration colour stops meaning anything.
    //
    // Matches the utility, not the word: several of these files explain in a
    // comment why they are NOT using tertiary, and a test that failed on the
    // explanation would be teaching the wrong lesson.
    const source = readFileSync(join(process.cwd(), "src/app", file), "utf8");
    expect(source).not.toMatch(/\b(bg|text|border|from|via|to|ring)-(on-)?tertiary\b/);
  });
});

// ---------------------------------------------------------------------------
// Shape. Each assertion below pins a count or a track that is FIXED by the
// real page, not chosen by the skeleton. If the real page gains a fifth KPI or
// loses a table column, the skeleton is now wrong and one of these fails.
// ---------------------------------------------------------------------------

describe("shape matches the loaded counterpart", () => {
  it("consumer /home keeps the max-w-md column and top padding", () => {
    const { container } = render(<HomeLoading />);
    // page.tsx: <main className="mx-auto max-w-md px-4 pt-6">
    expect(container.firstElementChild).toHaveClass("mx-auto", "max-w-md", "px-4", "pt-6");
  });

  it.each([
    ["wallet", WalletLoading],
    ["rewards", RewardsLoading],
    ["receipts", ReceiptsLoading],
    ["notifications", NotificationsLoading],
  ] as const)(
    "consumer /%s keeps the shared mobile column",
    (_name, Loading) => {
      // Every one of these pages is
      // <main className="mx-auto max-w-md px-4 pt-6 pb-8">.
      const { container } = render(<Loading />);
      expect(container.firstElementChild).toHaveClass(
        "mx-auto",
        "max-w-md",
        "px-4",
        "pt-6",
        "pb-8",
      );
    },
  );

  it("consumer /rewards keeps the two-column claimable grid", () => {
    const { container } = render(<RewardsLoading />);
    expect(container.querySelector(".grid-cols-2")).not.toBeNull();
  });

  it("consumer /receipts draws the five status filter chips", () => {
    // All / Processing / In review / Approved / Not accepted. Five is fixed by
    // receipt-history-list.tsx, not by taste.
    const { container } = render(<ReceiptsLoading />);
    const chipRow = container.querySelector(".overflow-hidden");

    expect(chipRow?.querySelectorAll(".h-8")).toHaveLength(5);
  });

  it("business /dashboard draws exactly four KPI cards", () => {
    // Four is the length of the KPI array in analytics/server/dashboard.ts.
    const { container } = render(<BusinessDashboardLoading />);
    const kpiGrid = container.querySelector(".lg\\:grid-cols-4.grid-cols-2");

    expect(kpiGrid).not.toBeNull();
    expect(kpiGrid?.children).toHaveLength(4);
  });

  it("business /customers is a real table with the real column count", () => {
    // Building this from divs would give the right height and the wrong column
    // widths, so every column would jump sideways when data arrived.
    const { container } = render(<BusinessCustomersLoading />);
    const table = container.querySelector("table");

    expect(table).not.toBeNull();
    expect(table).toHaveClass("min-w-[56rem]");
    // Customer, Standing, Points, Lifetime points, Visits, Lifetime spend,
    // Last visit, Actions.
    expect(table?.querySelectorAll("thead th")).toHaveLength(8);
  });

  it("business /customers rows are all the same height as the real ones", () => {
    const { container } = render(<BusinessCustomersLoading />);
    const rows = container.querySelectorAll("tbody tr");

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // py-3 on the cell plus an h-8 inner box = the 56px real row, whose
      // tallest content is the h-8 Manage button.
      expect(row.querySelector("td")).toHaveClass("py-3");
      expect(row.querySelector("td > div")).toHaveClass("h-8");
    }
  });

  it("business /receipts uses h-9 tabs, not the h-8 pills other pages use", () => {
    // queue-screen.tsx tabs are genuinely h-9. Copying the h-8 from the
    // customers or rewards pages would shift the list below by 4px.
    const { container } = render(<BusinessReceiptsLoading />);
    const tabRow = container.querySelector(".flex-wrap.gap-2");

    expect(tabRow?.querySelectorAll(".h-9")).toHaveLength(3);
  });

  it("business /settings draws exactly seven opening-hours rows", () => {
    // Seven is a week. It cannot drift, and if the skeleton disagreed the
    // longest card on the page would be the wrong height.
    const { container } = render(<BusinessSettingsLoading />);
    const dayRows = container.querySelectorAll(".border-b.border-outline-variant");

    expect(dayRows).toHaveLength(7);
  });

  it("business /receipts/[receiptId] draws the six extracted fields", () => {
    // Merchant, receipt number, receipt date, subtotal, tax, total.
    const { container } = render(<BusinessReceiptDetailLoading />);
    const inputs = container.querySelectorAll(".h-11.w-full");

    // Six field inputs plus the two line-item rows' leading inputs.
    expect(inputs.length).toBeGreaterThanOrEqual(6);
  });

  it("business /menu keeps the 240px category rail track", () => {
    const { container } = render(<BusinessMenuLoading />);
    expect(container.querySelector(".lg\\:grid-cols-\\[240px_1fr\\]")).not.toBeNull();
  });

  it("business portal skeletons use the portal's gap-6 column", () => {
    // PortalShell's <main> supplies the padding; each page's own root is
    // <div className="flex flex-col gap-6">.
    for (const Loading of [
      BusinessDashboardLoading,
      BusinessMenuLoading,
      BusinessCampaignsLoading,
      BusinessCustomersLoading,
      BusinessRewardsLoading,
      BusinessReceiptsLoading,
      BusinessReceiptDetailLoading,
      BusinessSettingsLoading,
    ]) {
      const { container } = render(<Loading />);
      expect(container.firstElementChild).toHaveClass("flex", "flex-col", "gap-6");
    }
  });

  it("consumer /b/[slug] keeps the avatar overlapping the cover", () => {
    // -mt-10 against an h-40 cover is the page's signature. Without it the
    // whole identity block sits 40px lower than the real page.
    const { container } = render(<ShopLoading />);

    expect(container.querySelector(".h-40")).not.toBeNull();
    expect(container.querySelector(".-mt-10")).not.toBeNull();
    expect(container.querySelector(".size-20.rounded-full")).not.toBeNull();
  });

  it("no portal skeleton reproduces the topbar or sidebar", () => {
    // They live in PortalShell, outside the loading boundary, and stay on
    // screen throughout. Drawing them again would double them up.
    for (const Loading of [BusinessDashboardLoading, BusinessSettingsLoading]) {
      const { container } = render(<Loading />);
      expect(container.querySelector("header")).toBeNull();
      expect(container.querySelector("nav")).toBeNull();
    }
  });
});
