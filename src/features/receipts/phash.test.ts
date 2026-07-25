import { describe, it, expect } from "vitest";

import {
  PHASH_BANDS,
  PHASH_BLOCK_SCORE,
  PHASH_HASH_HEX_LENGTH,
  PHASH_WARN_SCORE,
  dctPhash,
  hammingDistance,
  phashBand,
} from "./phash";
import type { PhashBands } from "./phash";

const SIZE = 32;

// Deterministic PRNG (mulberry32). Never Math.random in tests: a pHash test
// that fails one run in fifty is worse than no test at all.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function build(fn: (x: number, y: number) => number, size = SIZE): number[][] {
  const rows: number[][] = [];
  for (let y = 0; y < size; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < size; x += 1) {
      row.push(Math.max(0, Math.min(255, Math.round(fn(x, y)))));
    }
    rows.push(row);
  }
  return rows;
}

// A synthetic 32x32 document: pale paper under uneven lighting, a dark
// header block, and text lines of varying length. This is the honest stand-in
// for a downsampled receipt, because it has energy spread across the low and
// mid frequencies the hash keeps.
const TEXT_LINE_EXTENT = [28, 30, 22, 26, 18, 24, 12, 20, 27, 16];
const receipt = build((x, y) => {
  const lighting = 235 - (y / (SIZE - 1)) * 25 - (x / (SIZE - 1)) * 10;
  if (y >= 2 && y <= 5) return x >= 6 && x <= 25 ? 45 : lighting; // header
  if (y >= 8 && y <= 27 && (y - 8) % 2 === 0) {
    const extent = TEXT_LINE_EXTENT[(y - 8) / 2] ?? 0;
    return x >= 3 && x < 3 + extent ? 55 : lighting;
  }
  if (y === 29) return x >= 3 && x <= 28 ? 60 : lighting; // totals rule
  return lighting;
});

function pixel(matrix: number[][], x: number, y: number): number {
  return matrix[y]?.[x] ?? 0;
}

// Same scene, re-encoded: low-amplitude deterministic noise on every pixel,
// which is what a JPEG round trip or a re-compression does to one photo.
function perturb(source: number[][], amplitude: number, seed: number): number[][] {
  const rng = mulberry32(seed);
  return source.map((row) =>
    row.map((value) =>
      Math.max(0, Math.min(255, Math.round(value + (rng() * 2 - 1) * amplitude))),
    ),
  );
}

const receiptPlusNoise = perturb(receipt, 6, 20260725);

// The same physical receipt photographed again, framed one pixel lower: doc
// 37's middle band, not a re-encode of one file.
const receiptShifted = build((x, y) => pixel(receipt, x, Math.min(SIZE - 1, y + 1)));

// A smooth diagonal gradient, an inverted document, stripes and a radial
// falloff: structurally different images.
const gradient = build((x, y) => ((x + y) / (2 * (SIZE - 1))) * 255);
const inverted = build((x, y) => 255 - pixel(receipt, x, y));
const verticalStripes = build((x) => (Math.floor(x / 4) % 2 === 0 ? 20 : 235));
const horizontalStripes = build((_x, y) => (Math.floor(y / 4) % 2 === 0 ? 20 : 235));
const radial = build((x, y) => {
  const dx = x - (SIZE - 1) / 2;
  const dy = y - (SIZE - 1) / 2;
  return 255 - Math.sqrt(dx * dx + dy * dy) * 11;
});

function flatten(matrix: number[][]): Uint8Array {
  const flat = new Uint8Array(matrix.length * matrix.length);
  for (let y = 0; y < matrix.length; y += 1) {
    for (let x = 0; x < matrix.length; x += 1) {
      flat[y * matrix.length + x] = pixel(matrix, x, y);
    }
  }
  return flat;
}

describe("dctPhash - shape and stability", () => {
  it("returns 16 lowercase hex characters", () => {
    const hash = dctPhash(receipt);
    expect(hash).toHaveLength(PHASH_HASH_HEX_LENGTH);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic: the same matrix hashes to the same string", () => {
    expect(dctPhash(receipt)).toBe(dctPhash(receipt));
    expect(dctPhash(verticalStripes)).toBe(dctPhash(verticalStripes));
  });

  // Golden vectors. Stored hashes are compared for the life of the platform,
  // so the convention documented at the top of phash.ts (orthonormal DCT-II,
  // top-left 8x8, median of the 63 non-DC coefficients, DC bit forced to 0,
  // bit 0 as the most significant bit) is frozen. If either value below
  // changes, the change is a data migration, not a refactor.
  it("matches the frozen golden vectors", () => {
    expect(dctPhash(receipt)).toBe("3f68e0b9a006d5d3");
    const ramp = build((x, y) => (y * SIZE + x) % 256);
    expect(dctPhash(ramp)).toBe("02387f38fb38aa38");
  });

  it("accepts a flat row-major Uint8Array and a matrix interchangeably", () => {
    expect(dctPhash(flatten(receipt))).toBe(dctPhash(receipt));
  });

  it("leaves the DC bit clear: the top nibble never exceeds 7", () => {
    for (const matrix of [receipt, gradient, inverted, verticalStripes, radial]) {
      expect(Number.parseInt(dctPhash(matrix).slice(0, 1), 16)).toBeLessThanOrEqual(
        7,
      );
    }
  });

  it("rejects a matrix with the wrong number of rows", () => {
    expect(() => dctPhash(receipt.slice(0, 31))).toThrow(/32/);
  });

  it("rejects a ragged row", () => {
    const ragged = receipt.map((row, y) => (y === 7 ? row.slice(0, 31) : [...row]));
    expect(() => dctPhash(ragged)).toThrow(/32/);
  });

  it("rejects a flat array of the wrong length", () => {
    expect(() => dctPhash(new Uint8Array(1000))).toThrow(/1024/);
  });

  it("rejects a non-finite pixel", () => {
    const broken = receipt.map((row, y) =>
      row.map((value, x) => (y === 3 && x === 4 ? Number.NaN : value)),
    );
    expect(() => dctPhash(broken)).toThrow(/finite/i);
  });

  it("honours an explicit source size", () => {
    const small = build((x, y) => ((x + y) / 30) * 255, 16);
    expect(dctPhash(small, 16)).toMatch(/^[0-9a-f]{16}$/);
    expect(() => dctPhash(small)).toThrow(/32/);
  });
});

describe("hammingDistance", () => {
  it("is zero for identical matrices", () => {
    expect(hammingDistance(dctPhash(receipt), dctPhash(receipt))).toBe(0);
    expect(hammingDistance(dctPhash(receipt), dctPhash(flatten(receipt)))).toBe(0);
  });

  it("is symmetric", () => {
    const a = dctPhash(receipt);
    const b = dctPhash(verticalStripes);
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });

  it("counts every differing bit across the full 64 bits", () => {
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
    // The high half must not be lost to 32-bit coercion.
    expect(hammingDistance("8000000000000000", "0000000000000000")).toBe(1);
    expect(hammingDistance("ffffffff00000000", "0000000000000000")).toBe(32);
    expect(hammingDistance("00000000ffffffff", "0000000000000000")).toBe(32);
  });

  it("accepts uppercase hex", () => {
    expect(hammingDistance("ABCDEF0123456789", "abcdef0123456789")).toBe(0);
  });

  it("throws on a short hash", () => {
    expect(() => hammingDistance("abc", "0000000000000000")).toThrow(
      /16 hex characters/,
    );
  });

  it("throws on mismatched lengths", () => {
    expect(() =>
      hammingDistance("0000000000000000", "00000000000000000"),
    ).toThrow(/16 hex characters/);
  });

  it("throws on non-hex characters", () => {
    expect(() => hammingDistance("zzzzzzzzzzzzzzzz", "0000000000000000")).toThrow(
      /16 hex characters/,
    );
  });

  it("throws on a 0x prefixed value", () => {
    expect(() => hammingDistance("0x00000000000000", "0000000000000000")).toThrow(
      /16 hex characters/,
    );
  });
});

describe("dctPhash - discrimination", () => {
  it("puts a low-amplitude re-encode of the same image inside the block band", () => {
    const distance = hammingDistance(
      dctPhash(receipt),
      dctPhash(receiptPlusNoise),
    );
    expect(distance).toBeGreaterThanOrEqual(0);
    expect(distance).toBeLessThanOrEqual(PHASH_BANDS.blockDistance);
    expect(phashBand(distance)).toEqual({
      severity: "block",
      score: PHASH_BLOCK_SCORE,
    });
  });

  it("puts a re-photograph of the same receipt in the warn band", () => {
    const distance = hammingDistance(dctPhash(receipt), dctPhash(receiptShifted));
    expect(distance).toBeGreaterThan(PHASH_BANDS.blockDistance);
    expect(distance).toBeLessThanOrEqual(PHASH_BANDS.warnDistance);
    expect(phashBand(distance)).toEqual({
      severity: "warn",
      score: PHASH_WARN_SCORE,
    });
  });

  it("puts an inverted image well outside every band", () => {
    const distance = hammingDistance(dctPhash(receipt), dctPhash(inverted));
    expect(distance).toBeGreaterThan(PHASH_BANDS.warnDistance);
    expect(phashBand(distance)).toBeNull();
  });

  it("puts structurally different documents well outside every band", () => {
    const pairs: Array<[number[][], number[][]]> = [
      [receipt, gradient],
      [receipt, verticalStripes],
      [receipt, radial],
      [gradient, radial],
      [verticalStripes, horizontalStripes],
      [radial, horizontalStripes],
    ];
    for (const [a, b] of pairs) {
      const distance = hammingDistance(dctPhash(a), dctPhash(b));
      expect(distance).toBeGreaterThan(PHASH_BANDS.warnDistance);
    }
  });
});

describe("phashBand", () => {
  it("exposes the doc 37 S1 defaults", () => {
    expect(PHASH_BANDS).toEqual({ blockDistance: 4, warnDistance: 10 });
    expect(PHASH_BLOCK_SCORE).toBe(1);
    expect(PHASH_WARN_SCORE).toBe(0.6);
  });

  it("blocks from 0 through 4", () => {
    for (const distance of [0, 1, 4]) {
      expect(phashBand(distance)).toEqual({ severity: "block", score: 1 });
    }
  });

  it("warns from 5 through 10", () => {
    for (const distance of [5, 7, 10]) {
      expect(phashBand(distance)).toEqual({ severity: "warn", score: 0.6 });
    }
  });

  it("emits no signal above 10", () => {
    expect(phashBand(11)).toBeNull();
    expect(phashBand(64)).toBeNull();
  });

  it("honours injected bands", () => {
    const bands: PhashBands = { blockDistance: 2, warnDistance: 6 };
    expect(phashBand(2, bands)).toEqual({ severity: "block", score: 1 });
    expect(phashBand(3, bands)).toEqual({ severity: "warn", score: 0.6 });
    expect(phashBand(6, bands)).toEqual({ severity: "warn", score: 0.6 });
    expect(phashBand(7, bands)).toBeNull();
  });

  it("throws on a distance outside 0 to 64", () => {
    expect(() => phashBand(-1)).toThrow(/0 and 64/);
    expect(() => phashBand(65)).toThrow(/0 and 64/);
  });

  it("throws on a non-integer distance", () => {
    expect(() => phashBand(3.5)).toThrow(/integer/);
  });
});
