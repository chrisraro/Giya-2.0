// Money is always stored as an integer number of centavos (1 peso = 100
// centavos) so amounts never touch floating-point arithmetic on the way to
// or from the database. These two helpers are the only places that convert
// between that integer representation and the peso strings shown to users.

const PESO_SIGN = "₱";

/**
 * Formats an integer centavos amount as a peso string, e.g. 125050 ->
 * "₱1,250.50". Pass { symbol: false } to omit the leading peso sign.
 * Throws if `centavos` is not a non-negative integer.
 */
export function formatPeso(centavos: number, opts: { symbol?: boolean } = {}): string {
  if (!Number.isInteger(centavos)) {
    throw new Error(`formatPeso: expected an integer number of centavos, got ${centavos}`);
  }
  if (centavos < 0) {
    throw new Error(`formatPeso: expected a non-negative amount, got ${centavos}`);
  }

  const symbol = opts.symbol ?? true;
  const pesos = centavos / 100;
  const formatted = pesos.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return symbol ? `${PESO_SIGN}${formatted}` : formatted;
}

/**
 * Parses a peso amount (string or number) into an integer number of
 * centavos, e.g. "1,250.50" -> 125050. Strips the peso sign, thousands
 * commas, and surrounding/internal whitespace before parsing. Throws on
 * non-numeric input, amounts with more than 2 decimal digits, or negative
 * amounts.
 *
 * Parsing is string-first (never `value * 100`) so half-centavo boundaries
 * can't be nudged by float rounding: the cleaned string is validated against
 * `-?\d+(\.\d{1,2})?`, split on ".", and the whole/fractional parts are
 * combined as integers. A third decimal digit (e.g. "1.005") is rejected
 * rather than silently rounded, since a centavo is the smallest unit money
 * is stored in.
 */
export function pesoToCentavos(input: string | number): number {
  const raw = typeof input === "number" ? input.toString() : input;
  const cleaned = raw.replace(new RegExp(`[${PESO_SIGN},\\s]`, "g"), "");

  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(`pesoToCentavos: could not parse "${input}" as a number.`);
  }
  if (cleaned.startsWith("-")) {
    throw new Error(`pesoToCentavos: expected a non-negative amount, got "${input}".`);
  }

  const [wholePart, fractionPart = ""] = cleaned.split(".");
  const paddedFraction = fractionPart.padEnd(2, "0");

  return Number(wholePart) * 100 + Number(paddedFraction);
}
