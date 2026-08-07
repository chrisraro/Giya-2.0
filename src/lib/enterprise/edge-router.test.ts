import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolveRegionTarget, buildEdgeCacheHeaders } from "./edge-router";

describe("Multi-Region Edge Router", () => {
  it("resolves optimal regional database target based on client region header", () => {
    const target = resolveRegionTarget("sin1"); // Singapore regional POP
    expect(target.region).toBe("ap-southeast-1");
    expect(target.isPrimary).toBe(true);
  });

  it("generates edge cache control headers for static/dynamic assets", () => {
    const headers = buildEdgeCacheHeaders({ isStatic: true, maxAgeSeconds: 3600 });
    expect(headers["Cache-Control"]).toContain("s-maxage=3600");
  });
});
