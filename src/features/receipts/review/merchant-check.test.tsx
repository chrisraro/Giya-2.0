import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { ReviewDecisionScreen } from "./decision-screen";
import { merchantCheckNotice } from "./presenter";
import type { MerchantCheckView, ParseMetaView, ReviewDecisionItem } from "./types";

// ===========================================================================
// How the two merchant-name findings reach a reviewer.
//
// The single most important assertion in this file is that "we could not read
// the shop name" and "the header reads JOLLIBEE" render as DIFFERENT things.
// They prompt completely different human decisions - one is a photo problem,
// the other is a receipt from somewhere else - and a queue that flattens them
// into one banner makes every reviewer re-derive the difference from the image.
//
// The second is that none of the copy accuses the consumer. The overwhelmingly
// common cause of both findings is a bad photograph of a genuine purchase, and
// a reviewer primed to suspect their own customer is a reviewer who will
// reject one.
// ===========================================================================

const BUSINESS = "Kape Bicolandia";
const RECEIPT_ID = "01980000-0000-7000-8000-0000000000f1";

function meta(check: MerchantCheckView | null): ParseMetaView {
  return {
    engine: "parse/v1",
    tier: "heuristic",
    templateId: null,
    fields: {},
    vatConsistent: true,
    withinAmountSanity: null,
    dateAmbiguous: false,
    notes: [],
    ocrMeanConfidence: 0.9,
    merchantCheck: check,
    reviewReasons: [],
  };
}

const MISMATCH: MerchantCheckView = {
  verdict: "mismatch",
  score: 0,
  threshold: 0.35,
  headerText: "JOLLIBEE",
  matchedAlias: null,
  rival: null,
};

const UNREADABLE: MerchantCheckView = {
  verdict: "unreadable",
  score: 0,
  threshold: 0.35,
  headerText: null,
  matchedAlias: null,
  rival: null,
};

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

describe("merchantCheckNotice", () => {
  it("says nothing at all when the check passed", () => {
    // A queue is a list of things needing a decision. A reassuring green box
    // for a check that passed is noise a reviewer learns to scroll past, which
    // costs attention on the ones that did not.
    expect(merchantCheckNotice(meta({ ...MISMATCH, verdict: "match" }), BUSINESS)).toBeNull();
  });

  it("says nothing on a receipt written before the check existed", () => {
    expect(merchantCheckNotice(meta(null), BUSINESS)).toBeNull();
    expect(merchantCheckNotice(null, BUSINESS)).toBeNull();
  });

  it("renders the two findings as different tones, titles and bodies", () => {
    const mismatch = merchantCheckNotice(meta(MISMATCH), BUSINESS);
    const unreadable = merchantCheckNotice(meta(UNREADABLE), BUSINESS);

    expect(mismatch?.tone).toBe("mismatch");
    expect(unreadable?.tone).toBe("unreadable");
    expect(mismatch?.title).not.toBe(unreadable?.title);
    expect(mismatch?.body).not.toBe(unreadable?.body);
  });

  it("offers the alias affordance for a mismatch and withholds it for an unreadable header", () => {
    // The sharpest way the two differ: there is literally nothing to learn
    // from a header that was never read.
    expect(merchantCheckNotice(meta(MISMATCH), BUSINESS)?.canLearnAlias).toBe(true);
    expect(merchantCheckNotice(meta(UNREADABLE), BUSINESS)?.canLearnAlias).toBe(false);
  });

  it("uses the honest merchant-facing sentence rather than an accusation", () => {
    const notice = merchantCheckNotice(meta(MISMATCH), BUSINESS);

    expect(notice?.title).toBe(`We could not confirm this receipt is from ${BUSINESS}`);
  });

  it("never accuses the consumer, in either variant", () => {
    // Nothing here may imply the customer did something. The finding is about
    // Giya's own uncertainty, and the reviewer decides.
    const accusatory = /fraud|fake|stole|stolen|cheat|lying|lied|scam|dishonest/i;
    for (const check of [MISMATCH, UNREADABLE]) {
      const notice = merchantCheckNotice(meta(check), BUSINESS);
      expect(`${notice?.title} ${notice?.body} ${notice?.rivalNote ?? ""}`).not.toMatch(
        accusatory,
      );
    }
  });

  it("names the rival merchant when one explains the header better", () => {
    const notice = merchantCheckNotice(
      meta({
        ...MISMATCH,
        headerText: "KAPE BICOL EXPRESS",
        rival: { businessId: "biz-rival", name: "Kape Bicol Express", score: 1 },
      }),
      BUSINESS,
    );

    expect(notice?.rivalNote).toContain("Kape Bicol Express");
    // The rival's opaque id is never rendered.
    expect(`${notice?.body} ${notice?.rivalNote}`).not.toContain("biz-rival");
  });

  it("carries no rival note when none was identified", () => {
    expect(merchantCheckNotice(meta(MISMATCH), BUSINESS)?.rivalNote).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The decision screen
// ---------------------------------------------------------------------------

function decisionItem(check: MerchantCheckView | null): ReviewDecisionItem {
  return {
    receiptId: RECEIPT_ID,
    status: "review",
    consumerName: "Karla Reyes",
    submittedByViewer: false,
    createdAt: "2026-07-25T09:00:00.000Z",
    reviewedAt: null,
    rejectReason: null,
    fields: {
      merchantName: check?.headerText ?? null,
      receiptNumber: "0012345",
      receiptDate: "2026-07-24T00:00:00.000Z",
      subtotalCentavos: 16_964,
      taxCentavos: 2_036,
      totalCentavos: 19_000,
    },
    lineItems: [],
    parseMeta: meta(check),
    parseConfidence: 0.95,
    matchConfidence: 0.85,
    signals: [],
    imageUrl: "https://signed.example/receipt.jpg",
    history: {
      receiptsAtBusiness: 4,
      approvedAtBusiness: 3,
      rejectedAtBusiness: 1,
      priorSignalsAtBusiness: 0,
    },
  };
}

// `ok: false as const` and the empty `fieldErrors` are both load-bearing: without
// the const assertion `ok` widens to boolean and the value stops matching the
// discriminated union, and `fieldErrors` is required on the failure arm.
const noop = () =>
  Promise.resolve({
    ok: false as const,
    code: "INVALID_INPUT" as const,
    message: "not used",
    fieldErrors: [] as string[],
  });

function renderScreen(
  check: MerchantCheckView | null,
  onLearnAlias?: (input: unknown) => Promise<
    { ok: true; alias: string; alreadyKnown: boolean } | { ok: false; code: "INVALID_INPUT"; message: string }
  >,
) {
  return render(
    <ReviewDecisionScreen
      item={decisionItem(check)}
      businessName={BUSINESS}
      now={new Date("2026-07-25T12:00:00.000Z")}
      onApprove={noop}
      onReject={noop}
      {...(onLearnAlias === undefined ? {} : { onLearnAlias })}
    />,
  );
}

describe("the decision screen's merchant-name banner", () => {
  it("shows the header text on a mismatch, so the reviewer reads what we read", () => {
    renderScreen(MISMATCH);

    expect(
      screen.getByText(`We could not confirm this receipt is from ${BUSINESS}`),
    ).toBeInTheDocument();
    expect(screen.getByText("What the top of the receipt says")).toBeInTheDocument();
    expect(screen.getAllByText("JOLLIBEE").length).toBeGreaterThan(0);
  });

  it("shows no header block and no alias button when the name could not be read", () => {
    renderScreen(UNREADABLE, () => Promise.resolve({ ok: true, alias: "x", alreadyKnown: false }));

    expect(
      screen.getByText("We could not read the shop name on this receipt"),
    ).toBeInTheDocument();
    expect(screen.queryByText("What the top of the receipt says")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /always accept it/i }),
    ).not.toBeInTheDocument();
  });

  it("renders no banner at all when the check passed", () => {
    renderScreen({ ...MISMATCH, verdict: "match" });

    expect(screen.queryByText(/could not confirm this receipt/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not read the shop name/i)).not.toBeInTheDocument();
  });

  it("sends only the receipt id when the reviewer teaches the header", async () => {
    // The header string is re-read server-side from parse_meta, so nothing
    // this component holds can widen what auto-approves at this business.
    const learn = vi.fn(() =>
      Promise.resolve({ ok: true as const, alias: "JOLLIBEE", alreadyKnown: false }),
    );
    renderScreen(MISMATCH, learn);

    fireEvent.click(screen.getByRole("button", { name: /always accept it/i }));

    await waitFor(() => expect(learn).toHaveBeenCalledTimes(1));
    expect(learn).toHaveBeenCalledWith({ receiptId: RECEIPT_ID });
  });

  it("confirms the save without deciding the receipt", async () => {
    const learn = vi.fn(() =>
      Promise.resolve({ ok: true as const, alias: "JOLLIBEE", alreadyKnown: false }),
    );
    renderScreen(MISMATCH, learn);

    fireEvent.click(screen.getByRole("button", { name: /always accept it/i }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/will be accepted from now on/i),
    );
    // The approve and reject actions are untouched: teaching an alias is not a
    // decision on this receipt, and the screen says so.
    expect(
      screen.getByRole("button", { name: "Approve and award points" }),
    ).toBeInTheDocument();
  });

  it("says so plainly when the alias was already known", async () => {
    const learn = vi.fn(() =>
      Promise.resolve({ ok: true as const, alias: "JOLLIBEE", alreadyKnown: true }),
    );
    renderScreen(MISMATCH, learn);

    fireEvent.click(screen.getByRole("button", { name: /always accept it/i }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/already on your list/i),
    );
  });

  it("renders the banner without the affordance when no action was wired", () => {
    renderScreen(MISMATCH);

    expect(
      screen.queryByRole("button", { name: /always accept it/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(`We could not confirm this receipt is from ${BUSINESS}`),
    ).toBeInTheDocument();
  });
});
