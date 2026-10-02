import { describe, expect, it, vi } from "vitest";

import { guardReadFailure, READ_FAILED_MESSAGE } from "./read-failure";

describe("guardReadFailure", () => {
  it("passes a successful result through untouched", async () => {
    await expect(guardReadFailure("t", async () => ({ ok: true as const }))).resolves.toEqual({ ok: true });
  });

  it("maps a thrown read failure to the generic typed error and logs the cause", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = new Error("getCampaignRow: read failed: connection reset");

    const result = await guardReadFailure("campaigns", async () => {
      throw cause;
    });

    expect(result).toEqual({ ok: false, message: READ_FAILED_MESSAGE });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("[campaigns]"), cause);
    // The internal error text must not reach the user-facing message.
    expect(READ_FAILED_MESSAGE).not.toContain("connection reset");
    logged.mockRestore();
  });
});
