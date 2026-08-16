import { render, screen } from "@testing-library/react";
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
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

// The page now reads the signed-in consumer, because both islands it renders
// are scoped to one: the queue card shows only that consumer's rows and the
// capture screen stamps them on anything it queues. See
// src/features/pwa/outbox.ts.
const auth = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: auth.getUser } }),
}));

const USER_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

const mocks = vi.hoisted(() => ({ loadScanTargets: vi.fn() }));
vi.mock("@/features/receipts/server/scan-targets", () => ({
  loadScanTargets: mocks.loadScanTargets,
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
  auth.getUser.mockResolvedValue({ data: { user: { id: USER_A } } });
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
