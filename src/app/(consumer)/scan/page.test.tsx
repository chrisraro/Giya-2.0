import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// /scan has exactly one job before it renders anything: decide whether this
// consumer has a business to scan FOR. Generic (unbound) scanning is [V1] in
// doc 33's route table and the pipeline never implemented it, so a receipt
// submitted with no business_id is rejected wrong_business every time and
// receipts_sha_unique then blocks re-submitting the same photo from the right
// store page. Offering the camera without a business is offering a guaranteed
// loss, and these tests are the fence against it coming back.

vi.mock("server-only", () => ({}));

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
}));

const mocks = vi.hoisted(() => ({
  loadScanTargets: vi.fn(),
  loadScanPreviewRule: vi.fn(),
  listActiveBusinesses: vi.fn(),
}));
vi.mock("@/features/receipts/server/scan-targets", () => ({
  loadScanTargets: mocks.loadScanTargets,
}));
vi.mock("@/features/receipts/server/preview-rule", () => ({
  loadScanPreviewRule: mocks.loadScanPreviewRule,
}));
vi.mock("@/features/businesses/server/public-repo", () => ({
  listActiveBusinesses: mocks.listActiveBusinesses,
}));

const ScanPage = (await import("./page")).default;

const BUSINESS_ID = "3f1b0d9c-4444-4444-8444-444444444444";

type ScanSearchParams = Record<string, string | string[] | undefined>;

async function renderScan(params: ScanSearchParams = {}): Promise<void> {
  render(await ScanPage({ searchParams: Promise.resolve(params) }));
}

/** The capture flow's own heading, from receipt-capture.tsx's idle step. */
const CAPTURE_MARKER = "Add your receipt";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadScanTargets.mockResolvedValue({
    recent: [],
    businesses: [
      {
        id: BUSINESS_ID,
        name: "Kape Diaria",
        logoUrl: null,
        cityName: "Cebu City",
        businessTypeName: "Cafe",
      },
    ],
    truncated: false,
  });
  mocks.listActiveBusinesses.mockResolvedValue([
    { id: BUSINESS_ID, slug: "kape-diaria", name: "Kape Diaria", logoUrl: null, cityName: null, businessTypeName: null },
  ]);
  // 1 point per ₱50, which is DELIBERATELY not the action's 1-point-per-peso
  // fallback: every points assertion below would also pass under the fallback
  // if the rate were 100.
  mocks.loadScanPreviewRule.mockResolvedValue({ rateCentavosPerPoint: 50, rounding: "floor" });
});

// T4.6: ScanPreview and previewReceiptPointsAction were both correct and both
// tested, and `rg -n "ScanPreview" src/` returned only the component's own
// definition. Working code no consumer could reach.
//
// These tests therefore go through the PAGE. Rendering <ScanPreview /> here
// would have passed for the whole time it was orphaned, which is the defect,
// and the estimate is driven by typing a real amount into the real input so
// that a mount which drops the rule prop cannot survive either.
describe("/scan points estimate", () => {
  async function typeAmount(pesos: string): Promise<void> {
    const field = screen.getByLabelText("Receipt total in pesos");
    await act(async () => {
      fireEvent.change(field, { target: { value: pesos } });
    });
  }

  it("CRITICAL: the page mounts the estimate for the bound shop", async () => {
    await renderScan({ business: BUSINESS_ID });

    expect(screen.getByLabelText("Receipt total in pesos")).toBeInTheDocument();
    expect(mocks.loadScanPreviewRule).toHaveBeenCalledWith(BUSINESS_ID);
  });

  it("CRITICAL: estimates under THIS shop's rule and names the shop", async () => {
    await renderScan({ business: BUSINESS_ID });
    await typeAmount("300");

    // 30000 centavos at 50 centavos per point = 600. Under the action's
    // unsupplied-rate fallback the same receipt reads 300, so this figure is
    // only reachable if the page passed the rule it read.
    expect(screen.getByText("~600 pts at Kape Diaria")).toBeInTheDocument();
  });

  it("honours the shop's rounding mode rather than assuming the house default", async () => {
    mocks.loadScanPreviewRule.mockResolvedValue({ rateCentavosPerPoint: 700, rounding: "ceil" });
    await renderScan({ business: BUSINESS_ID });
    await typeAmount("100");

    // 10000 / 700 = 14.28..., which floors to 14 and ceils to 15.
    expect(screen.getByText("~15 pts at Kape Diaria")).toBeInTheDocument();
  });

  it("CRITICAL: shows no estimate at all for a shop with no amount-rate rule to preview", async () => {
    mocks.loadScanPreviewRule.mockResolvedValue(null);
    await renderScan({ business: BUSINESS_ID });

    // A number under the platform default would be a different shop's number.
    expect(screen.queryByLabelText("Receipt total in pesos")).not.toBeInTheDocument();
    expect(await screen.findByText(CAPTURE_MARKER)).toBeInTheDocument();
  });

  it("CRITICAL: a failed rule read costs the estimate, not the camera", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.loadScanPreviewRule.mockRejectedValue(new Error("permission denied for table points_rules"));

    await renderScan({ business: BUSINESS_ID });

    expect(await screen.findByText(CAPTURE_MARKER)).toBeInTheDocument();
    expect(screen.queryByLabelText("Receipt total in pesos")).not.toBeInTheDocument();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("drops the estimate when the bound business is not publicly readable", async () => {
    // Deactivated or soft-deleted: there is no name to attach the figure to, and
    // "~600 pts at " is not a sentence.
    mocks.listActiveBusinesses.mockResolvedValue([]);
    await renderScan({ business: BUSINESS_ID });

    expect(screen.queryByLabelText("Receipt total in pesos")).not.toBeInTheDocument();
  });

  it("reads no preview rule on the chooser path, where there is no shop yet", async () => {
    await renderScan();

    expect(mocks.loadScanPreviewRule).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Receipt total in pesos")).not.toBeInTheDocument();
  });
});

describe("/scan with no business", () => {
  it("CRITICAL: never renders the capture flow, which could only produce a rejection", async () => {
    await renderScan();

    expect(screen.queryByText(CAPTURE_MARKER)).not.toBeInTheDocument();
  });

  it("renders the store chooser instead, linking into the pre-bound flow", async () => {
    await renderScan();

    expect(screen.getByRole("heading", { name: "Which shop is this from?" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Kape Diaria/ })).toHaveAttribute(
      "href",
      `/scan?business=${BUSINESS_ID}`,
    );
  });

  it("passes a sanitised ?q= through to the store read", async () => {
    await renderScan({ q: "  kape%_diaria  " });

    expect(mocks.loadScanTargets).toHaveBeenCalledWith({ query: "kape diaria" });
  });
});

describe("/scan?business=", () => {
  it("renders the capture flow for a valid business id and reads no store list", async () => {
    await renderScan({ business: BUSINESS_ID });

    expect(await screen.findByText(CAPTURE_MARKER)).toBeInTheDocument();
    expect(mocks.loadScanTargets).not.toHaveBeenCalled();
  });

  it("accepts the business_id alias the submit API uses", async () => {
    await renderScan({ business_id: BUSINESS_ID });

    expect(await screen.findByText(CAPTURE_MARKER)).toBeInTheDocument();
  });

  it("CRITICAL: falls back to the chooser for a hand-typed non-UUID rather than capturing", async () => {
    // parseBusinessIdParam drops it, and a dropped id must mean "choose a
    // shop", never "scan unbound".
    await renderScan({ business: "kape-diaria" });

    expect(screen.queryByText(CAPTURE_MARKER)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Which shop is this from?" })).toBeInTheDocument();
    expect(mocks.loadScanTargets).toHaveBeenCalled();
  });
});
