import { describe, expect, it } from "vitest";

import { parseReceipt } from "@/features/receipts/parse";

import { reconstructDocument } from "../../../../../supabase/functions/ocr/vision";
import type { VisionFullTextAnnotation } from "../../../../../supabase/functions/ocr/vision";
import fixture from "./vision-response.fixture.json";

// THE REGRESSION THIS FILE EXISTS FOR.
//
// `vision-response.fixture.json` is the REAL Google Cloud Vision v1
// `fullTextAnnotation` for the KAPE DIARIA test receipt, recorded from a live
// `images:annotate` DOCUMENT_TEXT_DETECTION call on 2026-07-26 (599ms, page
// confidence 0.98076, 20 blocks, 49 words). Only fields this pipeline never
// reads were pruned - per-symbol bounding boxes, detected-language hints, the
// duplicate `textAnnotations` array - so the nesting, every coordinate, every
// confidence and every detectedBreak is exactly what Google returned.
//
// The receipt's ground truth: TOTAL 150.00, CASH tendered 200.00.
//
// Vision's own `fullTextAnnotation.text` puts "TOTAL" and "150.00" on separate
// lines, and "CASH" and "200.00" on two more. Fed to `parseReceipt` that text
// yields 20000 centavos - the CASH line - because no total keyword has an
// amount beside it and the tier-2 "largest amount near the foot" fallback
// takes over. A 33% over-award, silent, on every receipt.
//
// So the first test below PINS THE DEFECT (so nobody "simplifies"
// supabase/functions/ocr/index.ts by passing `fullTextAnnotation.text` through
// as `raw_text`) and the second proves the reconstruction fixes it.

const visionResponse = fixture as VisionFullTextAnnotation;

/** The recorded receipt's ground truth, in integer centavos. */
const TRUE_TOTAL_CENTAVOS = 15_000;
/** What the parser reads instead when the lines are not reconstructed: the
 * CASH tendered. */
const CASH_TENDERED_CENTAVOS = 20_000;

function clone(annotation: VisionFullTextAnnotation): VisionFullTextAnnotation {
  return JSON.parse(JSON.stringify(annotation)) as VisionFullTextAnnotation;
}

/** Rotate every vertex about the image origin, simulating a receipt
 * photographed at an angle. Corner ORDER is preserved, which is what Vision
 * itself does on a tilted photo: corner 0 stays the top-left in reading
 * order. */
function rotate(annotation: VisionFullTextAnnotation, degrees: number): VisionFullTextAnnotation {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rotated = clone(annotation);
  for (const page of rotated.pages ?? []) {
    for (const block of page.blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        for (const word of paragraph.words ?? []) {
          for (const vertex of word.boundingBox?.vertices ?? []) {
            const x = vertex.x ?? 0;
            const y = vertex.y ?? 0;
            vertex.x = x * cos - y * sin;
            vertex.y = x * sin + y * cos;
          }
        }
      }
    }
  }
  return rotated;
}

/** Replace absolute `vertices` with `normalizedVertices`, the other shape the
 * Vision API is documented to return. */
function normalizeVertices(annotation: VisionFullTextAnnotation): VisionFullTextAnnotation {
  const converted = clone(annotation);
  for (const page of converted.pages ?? []) {
    const width = page.width ?? 1;
    const height = page.height ?? 1;
    for (const block of page.blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        for (const word of paragraph.words ?? []) {
          const box = word.boundingBox;
          if (box?.vertices === undefined) continue;
          box.normalizedVertices = box.vertices.map((vertex) => ({
            x: (vertex.x ?? 0) / width,
            y: (vertex.y ?? 0) / height,
          }));
          delete box.vertices;
        }
      }
    }
  }
  return converted;
}

const EXPECTED_LINES = [
  "KAPE DIARIA",
  "Naga City Branch",
  "TIN 123-456-789-000",
  "OFFICIAL RECEIPT",
  "OR# 004512",
  "07/26/2026 14:32",
  "2 Kapeng Barako 90.00",
  "1 Pandesal Bilao 45.00",
  "1 Turon 15.00",
  "VATABLE SALES 133.93",
  "VAT (12%) 16.07",
  "TOTAL 150.00",
  "CASH 200.00",
  "CHANGE 50.00",
  "THIS SERVES AS AN OFFICIAL RECEIPT",
  "Salamat po!",
];

describe("Vision fullTextAnnotation.text, unreconstructed", () => {
  it("splits labels from their amounts", () => {
    // Not an assertion about our code. An assertion about Google's output, so
    // the premise of everything below is visible and checkable.
    expect(visionResponse.text).toContain("TOTAL\n150.00");
    expect(visionResponse.text).toContain("CASH\n200.00");
  });

  it("makes parseReceipt read the CASH line as the total", () => {
    const parsed = parseReceipt({ rawText: visionResponse.text ?? "" });

    expect(parsed.totalCentavos).toBe(CASH_TENDERED_CENTAVOS);
    expect(parsed.totalCentavos).not.toBe(TRUE_TOTAL_CENTAVOS);
    // The only downstream hint that anything went wrong, and it is weak: the
    // VAT block no longer reconciles against the inflated "total". A receipt
    // routed on this alone still auto-approves once the other fields are good.
    expect(parsed.vatConsistent).toBe(false);
  });
});

describe("reconstructDocument", () => {
  it("rebuilds the printed lines from word geometry", () => {
    const document = reconstructDocument(visionResponse);

    expect(document.text.split("\n")).toEqual(EXPECTED_LINES);
    expect(document.wordCount).toBe(49);
    // The recorded receipt is a flat scan, so there is nothing to deskew.
    expect(Math.abs(document.skewDegrees)).toBeLessThan(0.01);
  });

  it("makes parseReceipt read the TOTAL line as the total", () => {
    const document = reconstructDocument(visionResponse);
    const parsed = parseReceipt({ rawText: document.text, blocks: document.blocks });

    // THE POINT OF THIS FILE.
    expect(parsed.totalCentavos).toBe(TRUE_TOTAL_CENTAVOS);
    expect(parsed.totalCentavos).not.toBe(CASH_TENDERED_CENTAVOS);

    expect(parsed.subtotalCentavos).toBe(13_393);
    expect(parsed.taxCentavos).toBe(1_607);
    expect(parsed.vatConsistent).toBe(true);
    expect(parsed.notes).toEqual([]);
  });

  it("recovers every other field the receipt prints", () => {
    const document = reconstructDocument(visionResponse);
    const parsed = parseReceipt({ rawText: document.text, blocks: document.blocks });

    expect(parsed.merchantName).toBe("KAPE DIARIA");
    expect(parsed.receiptNumber).toBe("OR004512");
    expect(parsed.receiptDate?.toISOString()).toBe("2026-07-26T06:32:00.000Z");
    expect(parsed.dateAmbiguous).toBe(false);
    expect(parsed.lineItems.map((item) => item.rawText)).toEqual([
      "2 Kapeng Barako 90.00",
      "1 Pandesal Bilao 45.00",
      "1 Turon 15.00",
    ]);
  });

  it("reports Vision's measured confidence rather than a placeholder", () => {
    const document = reconstructDocument(visionResponse);

    // Vision's own page confidence, 0.98075724, not the 0.5 the VLM engine was
    // forced to invent because it emitted no confidences at all.
    expect(document.meanConfidence).toBeCloseTo(0.98076, 4);
  });

  it("emits one line-granular block per printed line, with real geometry", () => {
    const document = reconstructDocument(visionResponse);

    expect(document.blocks).toHaveLength(EXPECTED_LINES.length);
    expect(document.blocks.map((block) => block.text)).toEqual(EXPECTED_LINES);

    // Blocks are LINES, not Vision's 20 paragraph-ish blocks. That matters:
    // parse.ts treats one block as one line, so returning Vision's grouping
    // would recreate the very defect this module removes, inside the
    // layout_anchors tier this time.
    expect(document.blocks).not.toHaveLength(20);

    const total = document.blocks.find((block) => block.text.startsWith("TOTAL"));
    expect(total).toBeDefined();
    expect(total?.bbox).toEqual([22, 331, 120, 340]);
    expect(total?.conf).toBeGreaterThan(0.9);

    // Top to bottom, and every box a real pixel rectangle.
    const tops = document.blocks.map((block) => block.bbox[1]);
    expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    for (const block of document.blocks) {
      expect(block.bbox[2]).toBeGreaterThan(block.bbox[0]);
      expect(block.bbox[3]).toBeGreaterThan(block.bbox[1]);
    }
  });

  it("unlocks the layout_anchors tier that had no geometry to resolve against", () => {
    const document = reconstructDocument(visionResponse);
    // Doc 36 Stage 6's own example totals band, verbatim.
    const parsed = parseReceipt({
      rawText: document.text,
      blocks: document.blocks,
      config: { layout_anchors: { totals: { y: [0.7, 0.92], align: "right" } } },
    });

    expect(parsed.totalCentavos).toBe(TRUE_TOTAL_CENTAVOS);
  });
});

describe("reconstructDocument, tilted receipts", () => {
  // A receipt photographed on a counter is never square to the lens. Grouping
  // on raw y would shred these: at 8 degrees across a 460px receipt the two
  // ends of one printed line differ by 60px of raw y, seven times the glyph
  // height, so adjacent lines interleave completely.
  //
  // 45 and 90 are here because an earlier draft REFUSED to deskew past 20
  // degrees and fell back to the raw frame. That did not fail safe: it grouped
  // words across four printed lines and still produced 20000 centavos, the
  // CASH line. The ceiling was removed; these two cases pin that.
  for (const degrees of [-90, -8, -3, 3, 8, 45, 90]) {
    it(`reconstructs the same receipt rotated ${degrees} degrees`, () => {
      const document = reconstructDocument(rotate(visionResponse, degrees));

      expect(document.text.split("\n")).toEqual(EXPECTED_LINES);
      expect(document.skewDegrees).toBeCloseTo(degrees, 1);
      expect(parseReceipt({ rawText: document.text }).totalCentavos).toBe(
        TRUE_TOTAL_CENTAVOS,
      );
      expect(parseReceipt({ rawText: document.text }).totalCentavos).not.toBe(
        CASH_TENDERED_CENTAVOS,
      );
    });
  }
});

describe("reconstructDocument, response-shape variations", () => {
  it("reads normalizedVertices as well as vertices", () => {
    const document = reconstructDocument(normalizeVertices(visionResponse));

    expect(document.text.split("\n")).toEqual(EXPECTED_LINES);
    expect(parseReceipt({ rawText: document.text }).totalCentavos).toBe(
      TRUE_TOTAL_CENTAVOS,
    );
  });

  it("returns empty text for an annotation carrying no words", () => {
    const document = reconstructDocument({ text: "", pages: [] });

    expect(document.text).toBe("");
    expect(document.blocks).toEqual([]);
    expect(document.wordCount).toBe(0);
  });

  it("does not throw on a response missing every optional field", () => {
    const document = reconstructDocument({ pages: [{ blocks: [{ paragraphs: [{}] }] }] });

    expect(document.text).toBe("");
    expect(document.wordCount).toBe(0);
  });
});
