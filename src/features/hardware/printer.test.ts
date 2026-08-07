import { describe, expect, it } from "vitest";
import { compileEscPosReceiptBytes } from "./printer";

describe("ESC/POS Thermal Printer Adapter", () => {
  it("compiles standard receipt JSON into ESC/POS binary buffer for network printers", () => {
    const bytes = compileEscPosReceiptBytes({
      storeName: "Star Coffee",
      receiptId: "REC-9988",
      items: [{ name: "Latte", price: "₱150.00" }],
      totalText: "Total: ₱150.00",
    });

    expect(bytes).toBeDefined();
    expect(bytes.length).toBeGreaterThan(0);
    // ESC/POS initialize command begins with ESC @ (0x1B, 0x40)
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x40);
  });
});
