import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readBusinessSuspension, readConsumerSuspension } from "./suspension";

function clientReturning(data: unknown, error: unknown = null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data, error }),
        }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("readConsumerSuspension", () => {
  it("returns 'suspended' when profiles.is_suspended is true", async () => {
    const client = clientReturning({ is_suspended: true });
    await expect(readConsumerSuspension(client, "u1")).resolves.toBe("suspended");
  });

  it("returns 'active' when profiles.is_suspended is false (the negative case)", async () => {
    const client = clientReturning({ is_suspended: false });
    await expect(readConsumerSuspension(client, "u1")).resolves.toBe("active");
  });

  it("returns 'unknown' on a read error rather than guessing", async () => {
    const client = clientReturning(null, { message: "boom" });
    await expect(readConsumerSuspension(client, "u1")).resolves.toBe("unknown");
  });

  it("returns 'unknown' when no row is found", async () => {
    const client = clientReturning(null, null);
    await expect(readConsumerSuspension(client, "u1")).resolves.toBe("unknown");
  });
});

describe("readBusinessSuspension", () => {
  it("returns 'suspended' when businesses.status is 'suspended'", async () => {
    const client = clientReturning({ status: "suspended" });
    await expect(readBusinessSuspension(client, "b1")).resolves.toBe("suspended");
  });

  it("returns 'active' for every other status value (the negative case)", async () => {
    for (const status of ["draft", "pending_verification", "active", "closed"]) {
      const client = clientReturning({ status });
      await expect(readBusinessSuspension(client, "b1")).resolves.toBe("active");
    }
  });

  it("returns 'unknown' on a read error rather than guessing", async () => {
    const client = clientReturning(null, { message: "boom" });
    await expect(readBusinessSuspension(client, "b1")).resolves.toBe("unknown");
  });

  it("returns 'unknown' when no row is found", async () => {
    const client = clientReturning(null, null);
    await expect(readBusinessSuspension(client, "b1")).resolves.toBe("unknown");
  });
});
