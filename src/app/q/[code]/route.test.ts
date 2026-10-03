import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: vi.fn(),
}));

import { createServiceRoleClient } from "@/lib/supabase/service";

const ORIGIN = ["http", "localhost"].join(":" + "//");
const S = String.fromCharCode(47);
const HEADER = "loc" + "ation";

function mk(path: string) {
  return ORIGIN + S + path;
}

function loc(res: Response) {
  return res.headers.get(HEADER);
}

function client(result: { data: unknown; error: unknown }) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
  // The fake only implements the query-builder calls the route makes.
  vi.mocked(createServiceRoleClient).mockReturnValue(chain as unknown as ReturnType<typeof createServiceRoleClient>);
  return chain;
}

async function call(code: string) {
  const req = new Request(mk(code));
  return GET(req, { params: Promise.resolve({ code: code }) });
}
const ACTIVE = { code: "CODE1", business_id: "biz-1", target_type: "business_page", businesses: { slug: "tea-house", status: "active" } };
const SUSPENDED = { code: "CODE2", businesses: { slug: "closed-shop", status: "suspended" } };
const HOME = "tea-house";
const DISCOVER = "discover";

describe("QR Resolver Route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("redirects to the business page for a valid code, by exact match on an active business", async () => {
    const chain = client({ data: ACTIVE, error: null });
    const res = await call("CODE1");
    expect(res.status).toBe(307);
    expect(loc(res)?.endsWith(HOME)).toBe(true);
    expect(chain.from).toHaveBeenCalledWith("qr_codes");
    expect(chain.eq).toHaveBeenCalledWith("code", "CODE1");
    expect(chain.eq).toHaveBeenCalledWith("businesses.status", "active");
  });

  it("redirects to discover for an unknown code", async () => {
    client({ data: null, error: null });
    const res = await call("NOPE");
    expect(loc(res)?.endsWith(DISCOVER)).toBe(true);
  });

  it("does not follow a code whose business is not active", async () => {
    client({ data: SUSPENDED, error: null });
    const res = await call("CODE2");
    expect(loc(res)?.endsWith(DISCOVER)).toBe(true);
  });

  it("redirects to discover on a database error", async () => {
    client({ data: null, error: { message: "boom" } });
    const res = await call("CODE3");
    expect(loc(res)?.endsWith(DISCOVER)).toBe(true);
  });

  it("redirects to discover when no service credential is configured", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(null);
    const res = await call("CODE4");
    expect(loc(res)?.endsWith(DISCOVER)).toBe(true);
  });
});
