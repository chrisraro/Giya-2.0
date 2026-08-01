// @vitest-environment node
//
// `receipts.parse_meta` is jsonb, so every read of it is a narrowing of an
// untrusted shape. These pin the merchant-name half of that narrowing: a row
// written by an older build has no `merchant_check` at all, and a row written
// by a future one may hold anything.
//
// Node environment because `./queue` is `server-only`.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import { parseParseMeta } from "./queue";

// ---------------------------------------------------------------------------
// parse_meta narrowing
// ---------------------------------------------------------------------------

describe("parseParseMeta on merchant_check", () => {
  it("reads what buildParseMeta writes", () => {
    const parsed = parseParseMeta({
      merchant_check: {
        verdict: "mismatch",
        score: 0.12,
        threshold: 0.35,
        header_text: "JOLLIBEE",
        matched_alias: null,
        rival: { business_id: "biz-rival", name: "Jollibee", score: 1 },
      },
      review_reasons: ["merchant_name_mismatch"],
    });

    expect(parsed?.merchantCheck).toEqual({
      verdict: "mismatch",
      score: 0.12,
      threshold: 0.35,
      headerText: "JOLLIBEE",
      matchedAlias: null,
      rival: { businessId: "biz-rival", name: "Jollibee", score: 1 },
    });
    expect(parsed?.reviewReasons).toEqual(["merchant_name_mismatch"]);
  });

  it("refuses to invent a verdict for a shape it has never seen", () => {
    // Guessing "match" would tell a reviewer a check passed that never ran;
    // guessing "mismatch" would accuse a shop on the strength of a missing key.
    for (const value of [
      {},
      { merchant_check: null },
      { merchant_check: "yes" },
      { merchant_check: { verdict: "probably" } },
      { merchant_check: [] },
    ]) {
      expect(parseParseMeta(value)?.merchantCheck).toBeNull();
    }
  });

  it("drops a rival with no name rather than rendering an empty one", () => {
    const parsed = parseParseMeta({
      merchant_check: { verdict: "mismatch", rival: { business_id: "biz" } },
    });

    expect(parsed?.merchantCheck?.rival).toBeNull();
  });

  it("treats absent review_reasons as none", () => {
    expect(parseParseMeta({ engine: "parse/v1" })?.reviewReasons).toEqual([]);
  });
});
