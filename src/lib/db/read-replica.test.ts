import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withReadReplica } from "./read-replica";

describe("Read Replica Query Router", () => {
  it("executes read queries against replica target with fallback", async () => {
    const fn = vi.fn().mockResolvedValue({ status: "ok" });
    const res = await withReadReplica(fn);
    expect(res).toEqual({ status: "ok" });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
