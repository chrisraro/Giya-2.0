// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/env", () => ({
  env: {},
  getServerEnv: () => ({}),
}));

import {
  DEFAULT_ROUTING_THRESHOLDS,
  parseConfidence,
  routeReceipt,
} from "../../confidence";
import { parseReceipt } from "../../parse";
import { STUB_OCR_ENGINE, STUB_OCR_ENGINE_VERSION, createStubOcrProvider } from "./stub";
import type { OcrRequest } from "./provider";

// A pinned clock, so "deterministic" means byte-identical and not merely
// "identical within the same day".
const FIXED_NOW = new Date("2026-07-25T04:00:00.000Z"); // 12:00 in Asia/Manila
const clock = () => FIXED_NOW;

const REQUEST: OcrRequest = {
  requestId: "req_01JSTUBFIXTURE",
  imageUrl: "https://storage.example.dev/receipts/user-1/abc.jpg",
  preprocess: "auto",
  langs: ["en"],
  returnBlocks: true,
};

function provider() {
  return createStubOcrProvider({ now: clock });
}

describe("stub OCR provider - provenance", () => {
  it("always reports engine 'stub' so stub rows are never mistaken for real OCR", async () => {
    const result = await provider().ocr(REQUEST);

    expect(result.engine).toBe(STUB_OCR_ENGINE);
    expect(result.engine).toBe("stub");
  });

  it("reports a clear engine version", async () => {
    const result = await provider().ocr(REQUEST);

    expect(result.engineVersion).toBe(STUB_OCR_ENGINE_VERSION);
    expect(result.engineVersion).toContain("stub");
  });

  it("identifies itself as the stub implementation", () => {
    expect(provider().name).toBe("stub");
  });

  it("exposes no health probe (that is the container's deploy gate)", () => {
    expect(provider().healthz).toBeUndefined();
  });

  it("reports preprocess ops that cannot be confused with real ones", async () => {
    const result = await provider().ocr(REQUEST);

    expect(result.preprocessOps).toEqual(["stub"]);
  });
});

describe("stub OCR provider - determinism", () => {
  it("returns identical output for the same input twice", async () => {
    const first = await provider().ocr(REQUEST);
    const second = await provider().ocr(REQUEST);

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("returns identical output across separate provider instances", async () => {
    const first = await createStubOcrProvider({ now: clock }).ocr(REQUEST);
    const second = await createStubOcrProvider({ now: clock }).ocr(REQUEST);

    expect(second).toEqual(first);
  });

  it("varies with the request id", async () => {
    const first = await provider().ocr(REQUEST);
    const second = await provider().ocr({ ...REQUEST, requestId: "req_01JOTHER" });

    expect(second.rawText).not.toBe(first.rawText);
  });

  it("varies with the image url", async () => {
    const first = await provider().ocr(REQUEST);
    const second = await provider().ocr({
      ...REQUEST,
      imageUrl: "https://storage.example.dev/receipts/user-1/zzz.jpg",
    });

    expect(second.rawText).not.toBe(first.rawText);
  });

  it("does not read the clock inside the generator (duration is fabricated, not measured)", async () => {
    const first = await provider().ocr(REQUEST);
    const second = await provider().ocr(REQUEST);

    expect(second.durationMs).toBe(first.durationMs);
  });
});

describe("stub OCR provider - response shape", () => {
  it("emits one block per printed line with plausible bboxes", async () => {
    const result = await provider().ocr(REQUEST);
    const printedLines = result.rawText.split("\n").filter((line) => line.trim().length > 0);

    expect(result.blocks).toHaveLength(printedLines.length);
    for (const block of result.blocks) {
      expect(block.bbox).toHaveLength(4);
      expect(block.bbox[3]).toBeGreaterThan(block.bbox[1]);
      expect(block.bbox[2]).toBeGreaterThan(block.bbox[0]);
    }
  });

  it("honours return_blocks: false", async () => {
    const result = await provider().ocr({ ...REQUEST, returnBlocks: false });

    expect(result.blocks).toEqual([]);
    expect(result.rawText.length).toBeGreaterThan(0);
  });

  it("reports a mean confidence inside the unit interval", async () => {
    const result = await provider().ocr(REQUEST);

    expect(result.meanConfidence).toBeGreaterThan(0);
    expect(result.meanConfidence).toBeLessThanOrEqual(1);
  });
});

// The point of these: the stub is only useful if the REAL parse engine can
// read it. If these fail, the stub is producing text that would send every
// dev receipt to `unreadable` and the end-to-end flow would never reach an
// approved outcome.
describe("stub OCR provider - output parses through the real parse engine", () => {
  it("yields a total, a date and a receipt number", async () => {
    const result = await provider().ocr(REQUEST);
    const parsed = parseReceipt({ rawText: result.rawText, blocks: result.blocks });

    expect(parsed.totalCentavos).not.toBeNull();
    expect(parsed.totalCentavos).toBeGreaterThan(0);
    expect(parsed.receiptDate).toBeInstanceOf(Date);
    expect(parsed.receiptNumber).toMatch(/^OR\d{7}$/);
    expect(parsed.merchantName).not.toBeNull();
  });

  it("passes the PH 12% VAT sanity check", async () => {
    const result = await provider().ocr(REQUEST);
    const parsed = parseReceipt({ rawText: result.rawText, blocks: result.blocks });

    expect(parsed.vatConsistent).toBe(true);
    expect(parsed.subtotalCentavos).not.toBeNull();
    expect(parsed.taxCentavos).not.toBeNull();
    expect((parsed.subtotalCentavos ?? 0) + (parsed.taxCentavos ?? 0)).toBe(
      parsed.totalCentavos,
    );
  });

  it("yields line items whose totals sum to the receipt total", async () => {
    const result = await provider().ocr(REQUEST);
    const parsed = parseReceipt({ rawText: result.rawText, blocks: result.blocks });

    expect(parsed.lineItems.length).toBeGreaterThanOrEqual(2);
    const sum = parsed.lineItems.reduce(
      (running, item) => running + (item.lineTotalCentavos ?? 0),
      0,
    );
    expect(sum).toBe(parsed.totalCentavos);
  });

  it("carries no parse notes (no ambiguous date, no VAT mismatch)", async () => {
    const result = await provider().ocr(REQUEST);
    const parsed = parseReceipt({ rawText: result.rawText, blocks: result.blocks });

    expect(parsed.notes).toEqual([]);
    expect(parsed.dateAmbiguous).toBe(false);
  });

  it("dates the receipt on the current Manila day, inside the freshness window", async () => {
    const result = await provider().ocr(REQUEST);
    const parsed = parseReceipt({ rawText: result.rawText, blocks: result.blocks });

    const manilaDay = (instant: Date) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(instant);

    expect(manilaDay(parsed.receiptDate ?? new Date(0))).toBe(manilaDay(FIXED_NOW));
  });

  it("reaches an approved routing outcome (doc 36 Stage 9)", async () => {
    const result = await provider().ocr(REQUEST);
    const parsed = parseReceipt({ rawText: result.rawText, blocks: result.blocks });

    const confidence = parseConfidence({
      total: parsed.totalCentavos === null ? "missing" : "validated",
      date: parsed.receiptDate === null ? "missing" : "validated",
      receiptNumber: parsed.receiptNumber === null ? "missing" : "validated",
      meanOcrConfidence: result.meanConfidence,
      vatConsistent: parsed.vatConsistent,
    });

    expect(confidence).toBeGreaterThanOrEqual(DEFAULT_ROUTING_THRESHOLDS.approve);
    expect(
      routeReceipt({
        parseConfidence: confidence,
        // Pre-bound scan with no contradicting evidence, doc 36 Stage 5 floor.
        matchConfidence: 0.85,
        fraud: { kind: "pass" },
        thresholds: DEFAULT_ROUTING_THRESHOLDS,
      }),
    ).toEqual({ status: "approved" });
  });

  it("parses cleanly for many different requests, not just the pinned fixture", async () => {
    const stub = provider();

    for (let i = 0; i < 200; i += 1) {
      const result = await stub.ocr({
        ...REQUEST,
        requestId: `req_fuzz_${i}`,
        imageUrl: `https://storage.example.dev/receipts/user-${i}/img-${i}.jpg`,
      });
      const parsed = parseReceipt({ rawText: result.rawText, blocks: result.blocks });

      expect(parsed.totalCentavos).not.toBeNull();
      expect(parsed.receiptDate).not.toBeNull();
      expect(parsed.receiptNumber).not.toBeNull();
      expect(parsed.vatConsistent).toBe(true);
      expect(parsed.notes).toEqual([]);
    }
  });
});
