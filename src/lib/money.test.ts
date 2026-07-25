import { describe, it, expect } from "vitest";

import { formatPeso, pesoToCentavos } from "./money";

describe("formatPeso", () => {
  it("formats zero centavos as 0.00 with the peso sign by default", () => {
    expect(formatPeso(0)).toBe("₱0.00");
  });

  it("formats a whole-peso amount with two decimal places", () => {
    expect(formatPeso(125050)).toBe("₱1,250.50");
  });

  it("groups thousands with commas", () => {
    expect(formatPeso(123456789)).toBe("₱1,234,567.89");
  });

  it("omits the peso sign when symbol:false", () => {
    expect(formatPeso(125050, { symbol: false })).toBe("1,250.50");
  });

  it("keeps the peso sign when symbol:true is explicit", () => {
    expect(formatPeso(125050, { symbol: true })).toBe("₱1,250.50");
  });

  it("formats zero without a sign as 0.00", () => {
    expect(formatPeso(0, { symbol: false })).toBe("0.00");
  });

  it("throws on a non-integer centavos value", () => {
    expect(() => formatPeso(10.5)).toThrow();
  });

  it("throws on a negative centavos value", () => {
    expect(() => formatPeso(-100)).toThrow();
  });
});

describe("pesoToCentavos", () => {
  it("parses a decimal string into integer centavos", () => {
    expect(pesoToCentavos("1250.50")).toBe(125050);
  });

  it("parses a plain integer string with no decimal part", () => {
    expect(pesoToCentavos("100")).toBe(10000);
  });

  it("parses a number input directly", () => {
    expect(pesoToCentavos(1250.5)).toBe(125050);
  });

  it("strips commas", () => {
    expect(pesoToCentavos("1,250.50")).toBe(125050);
  });

  it("strips the peso sign", () => {
    expect(pesoToCentavos("₱1,250.50")).toBe(125050);
  });

  it("strips surrounding and internal spaces", () => {
    expect(pesoToCentavos(" ₱ 1,250.50 ")).toBe(125050);
  });

  it("throws on NaN input", () => {
    expect(() => pesoToCentavos("not a number")).toThrow();
  });

  it("throws on a negative amount", () => {
    expect(() => pesoToCentavos("-5.00")).toThrow();
  });

  it("throws on a negative number input", () => {
    expect(() => pesoToCentavos(-5)).toThrow();
  });

  it("throws on more than 2 decimal digits instead of rounding", () => {
    expect(() => pesoToCentavos("1.005")).toThrow();
    expect(() => pesoToCentavos("10.005")).toThrow();
    expect(() => pesoToCentavos("1.999")).toThrow();
  });

  it("parses two decimal digits exactly", () => {
    expect(pesoToCentavos("1.01")).toBe(101);
  });

  it("pads a single decimal digit to a full centavo", () => {
    expect(pesoToCentavos("1.1")).toBe(110);
  });

  it("parses a bare integer string", () => {
    expect(pesoToCentavos("1")).toBe(100);
  });

  it("parses a larger decimal amount", () => {
    expect(pesoToCentavos("1250.50")).toBe(125050);
  });

  it("throws on non-numeric input", () => {
    expect(() => pesoToCentavos("abc")).toThrow();
  });

  it("throws on a negative amount string", () => {
    expect(() => pesoToCentavos("-5")).toThrow();
  });
});

describe("round-trip", () => {
  it("formatPeso -> pesoToCentavos recovers the original centavos", () => {
    const original = 987654321;
    const formatted = formatPeso(original, { symbol: false });
    expect(pesoToCentavos(formatted)).toBe(original);
  });

  it("pesoToCentavos -> formatPeso recovers the original string", () => {
    const original = "2,500.75";
    const centavos = pesoToCentavos(original);
    expect(formatPeso(centavos, { symbol: false })).toBe(original);
  });

  it("round-trips zero", () => {
    expect(pesoToCentavos(formatPeso(0, { symbol: false }))).toBe(0);
  });
});
