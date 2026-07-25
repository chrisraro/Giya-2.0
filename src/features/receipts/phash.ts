import { FRAUD_SIGNAL_SPECS } from "./fraud";
import type { FraudSeverity } from "./fraud";

// Pure perceptual hashing, per docs/30-modules/36-receipt-ocr-pipeline.md
// Stage 1 and docs/30-modules/37-fraud-detection.md S1. ZERO IO: sharp (or
// any decoder) supplies the grayscale pixels, this module only does the maths.
//
// ============================ FROZEN CONVENTION ============================
// Stored hashes must stay comparable forever: a receipts.image_hash written
// today is compared against hashes written years from now. Changing anything
// below silently invalidates every historical comparison, so it is spelled
// out exactly and must not be "improved".
//
//  1. Input: a size x size grayscale matrix (default 32 x 32), row-major,
//     gray[y][x], pixel values 0-255. A flat Uint8Array of size*size is the
//     same data in the same row-major order.
//  2. Transform: 2D DCT-II in the ORTHONORMAL form, computed directly:
//        F(u,v) = a(u) a(v) SUM_y SUM_x f(y,x)
//                 cos((2x+1) v PI / 2N) cos((2y+1) u PI / 2N)
//     with a(0) = sqrt(1/N), a(k>0) = sqrt(2/N), N = size. The a() factors
//     are per-coefficient, so they are part of the convention, not decoration.
//     Only the 64 surviving coefficients are computed, by a separable pair of
//     naive sums (64 x 1024 multiply-adds). Clarity and permanence beat speed.
//  3. Kept coefficients: the top-left 8 x 8 block, u = 0..7 (vertical
//     frequency), v = 0..7 (horizontal frequency).
//  4. Threshold: the median of the 63 coefficients EXCLUDING the DC term
//     F(0,0). DC is total image brightness; it dwarfs the rest and carries no
//     structure, so including it would drag the median and waste bits. 63 is
//     odd, so the median is the exact middle element of the ascending sort,
//     never an average of two.
//  5. Bits: bit index i = u * 8 + v (row-major over the 8 x 8 block).
//       - bit 0 (the DC slot) is ALWAYS 0. The DC term gets no bit of its
//         own; the slot is kept so the hash is exactly 64 bits wide.
//         Consequence: the first hex character is always in 0-7.
//       - bit i > 0 is 1 when coefficient > median, else 0. Exact equality
//         with the median yields 0.
//  6. Hex: bit 0 is the MOST significant bit of the 64-bit value. Bits are
//     emitted four at a time, most significant first, as 16 LOWERCASE hex
//     characters (bits 0-3 form the first character).
// ==========================================================================

// Severity vocabulary is the fraud engine's (fraud.ts); pHash only ever
// reaches the two S1 bands. Scores come from the S1 rows of
// FRAUD_SIGNAL_SPECS so the band table here and the signal catalog there
// cannot drift apart.
export type PhashSeverity = Extract<FraudSeverity, "block" | "warn">;

export interface PhashBands {
  // Hamming distance <= blockDistance -> block.
  blockDistance: number;
  // Hamming distance <= warnDistance (and > blockDistance) -> warn.
  warnDistance: number;
}

export interface PhashSignal {
  severity: PhashSeverity;
  score: number;
}

// Defaults from doc 37 S1; settings keys fraud.phash_block_distance and
// fraud.phash_warn_distance override them.
export const PHASH_BANDS: PhashBands = { blockDistance: 4, warnDistance: 10 };
export const PHASH_BLOCK_SCORE = FRAUD_SIGNAL_SPECS.phash_near_identical.score;
export const PHASH_WARN_SCORE = FRAUD_SIGNAL_SPECS.phash_similar.score;

export const PHASH_BITS = 64;
export const PHASH_HASH_HEX_LENGTH = 16;

const DEFAULT_SOURCE_SIZE = 32;
const BLOCK_SIDE = 8;
const HASH_HEX_PATTERN = /^[0-9a-fA-F]{16}$/;

// Every index in this module is derived from the already-validated source
// size, so an out-of-range read is a programming error, not bad input. Read
// through this rather than defaulting to 0, which would quietly corrupt the
// transform.
function at(buffer: Float64Array, index: number): number {
  const value = buffer[index];
  if (value === undefined) {
    throw new RangeError(`Perceptual hash buffer index ${index} out of range`);
  }
  return value;
}

// Cosine tables depend only on the source size, so they are memoized per
// size. table[k * size + j] = cos((2j + 1) k PI / 2N) for the kept k values.
const cosineTables = new Map<number, Float64Array>();

function cosineTable(size: number): Float64Array {
  const cached = cosineTables.get(size);
  if (cached !== undefined) return cached;
  const table = new Float64Array(BLOCK_SIDE * size);
  for (let k = 0; k < BLOCK_SIDE; k += 1) {
    for (let j = 0; j < size; j += 1) {
      table[k * size + j] = Math.cos(((2 * j + 1) * k * Math.PI) / (2 * size));
    }
  }
  cosineTables.set(size, table);
  return table;
}

function alpha(k: number, size: number): number {
  return k === 0 ? Math.sqrt(1 / size) : Math.sqrt(2 / size);
}

// Normalize either input shape into a flat row-major buffer, validating
// hard. A wrongly shaped matrix would otherwise produce a plausible-looking
// but meaningless hash, and that hash would be stored as evidence.
function toFlat(gray: number[][] | Uint8Array, size: number): Float64Array {
  const expected = size * size;
  const flat = new Float64Array(expected);
  if (gray instanceof Uint8Array) {
    if (gray.length !== expected) {
      throw new Error(
        `dctPhash expects a flat array of ${expected} pixels, received ${gray.length}`,
      );
    }
    flat.set(gray);
    return flat;
  }
  if (gray.length !== size) {
    throw new Error(
      `dctPhash expects ${size} rows of ${size} pixels, received ${gray.length} rows`,
    );
  }
  let y = 0;
  for (const row of gray) {
    if (row.length !== size) {
      throw new Error(
        `dctPhash expects ${size} rows of ${size} pixels, row ${y} has ${row.length}`,
      );
    }
    let x = 0;
    for (const value of row) {
      if (!Number.isFinite(value)) {
        throw new Error(
          `dctPhash received a non-finite pixel at row ${y}, column ${x}`,
        );
      }
      flat[y * size + x] = value;
      x += 1;
    }
    y += 1;
  }
  return flat;
}

// 64-bit DCT perceptual hash as 16 lowercase hex characters.
export function dctPhash(
  gray: number[][] | Uint8Array,
  size: number = DEFAULT_SOURCE_SIZE,
): string {
  if (!Number.isInteger(size) || size < BLOCK_SIDE) {
    throw new Error(
      `dctPhash source size must be an integer >= ${BLOCK_SIDE}, received ${size}`,
    );
  }
  const flat = toFlat(gray, size);
  const cos = cosineTable(size);

  // Separable transform: rows first (horizontal frequency v), then columns
  // (vertical frequency u). Identical to the double sum in the convention
  // above, with each alpha factor applied exactly once.
  const rowPass = new Float64Array(size * BLOCK_SIDE);
  for (let y = 0; y < size; y += 1) {
    for (let v = 0; v < BLOCK_SIDE; v += 1) {
      let sum = 0;
      for (let x = 0; x < size; x += 1) {
        sum += at(flat, y * size + x) * at(cos, v * size + x);
      }
      rowPass[y * BLOCK_SIDE + v] = alpha(v, size) * sum;
    }
  }

  const coefficients = new Float64Array(PHASH_BITS);
  for (let u = 0; u < BLOCK_SIDE; u += 1) {
    for (let v = 0; v < BLOCK_SIDE; v += 1) {
      let sum = 0;
      for (let y = 0; y < size; y += 1) {
        sum += at(rowPass, y * BLOCK_SIDE + v) * at(cos, u * size + y);
      }
      coefficients[u * BLOCK_SIDE + v] = alpha(u, size) * sum;
    }
  }

  // Median of the 63 non-DC coefficients (index 0 is DC).
  const withoutDc = Array.from(coefficients).slice(1).sort((a, b) => a - b);
  const median = withoutDc[(withoutDc.length - 1) / 2];
  if (median === undefined) {
    throw new Error("dctPhash could not derive a median coefficient");
  }

  let hex = "";
  for (let nibble = 0; nibble < PHASH_HASH_HEX_LENGTH; nibble += 1) {
    let value = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      const index = nibble * 4 + bit;
      // Index 0 is the DC slot and stays 0 by convention.
      const set = index > 0 && at(coefficients, index) > median;
      value = (value << 1) | (set ? 1 : 0);
    }
    hex += value.toString(16);
  }
  return hex;
}

// XOR + popcount over the full 64 bits, as two unsigned 32-bit halves.
// Deliberately not one 64-bit value through JS bitwise operators: those
// coerce to 32-bit signed and would silently drop the high half. (BigInt
// would also work, but BigInt literals need a target above ES2017.)
export function hammingDistance(hexA: string, hexB: string): number {
  const a = parseHash(hexA);
  const b = parseHash(hexB);
  return popcount32(a.high ^ b.high) + popcount32(a.low ^ b.low);
}

function parseHash(hex: string): { high: number; low: number } {
  if (!HASH_HEX_PATTERN.test(hex)) {
    throw new Error(
      `Malformed perceptual hash "${hex}": expected exactly 16 hex characters`,
    );
  }
  return {
    high: Number.parseInt(hex.slice(0, 8), 16) >>> 0,
    low: Number.parseInt(hex.slice(8), 16) >>> 0,
  };
}

// Standard SWAR population count over one unsigned 32-bit word.
function popcount32(word: number): number {
  let x = word >>> 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

// Doc 37 S1 band table. Returns null above the warn band: different
// document, no signal row is written at all.
export function phashBand(
  distance: number,
  bands: PhashBands = PHASH_BANDS,
): PhashSignal | null {
  if (!Number.isInteger(distance)) {
    throw new Error(`Hamming distance must be an integer, received ${distance}`);
  }
  if (distance < 0 || distance > PHASH_BITS) {
    throw new Error(
      `Hamming distance must be between 0 and ${PHASH_BITS}, received ${distance}`,
    );
  }
  if (distance <= bands.blockDistance) {
    return { severity: "block", score: PHASH_BLOCK_SCORE };
  }
  if (distance <= bands.warnDistance) {
    return { severity: "warn", score: PHASH_WARN_SCORE };
  }
  return null;
}
