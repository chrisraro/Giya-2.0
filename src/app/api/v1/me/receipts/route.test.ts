import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReceiptListItemDTO, ReceiptStatus } from "@/features/receipts/types";
import { decodeCursor, encodeCursor } from "@/lib/api/cursor";

// GET /api/v1/me/receipts - doc 36's "Own history, cursor, ?status= filter".
//
// The repository is mocked at its own boundary so these tests are about the
// HTTP contract: doc 13's envelope, its cursor pagination (never an offset),
// the status filter, and the fact that a receipt body never carries anything
// the client is not granted.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  listMyReceipts: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));

vi.mock("@/features/receipts/server/repo", () => ({
  listMyReceipts: mocks.listMyReceipts,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
}));

const { GET } = await import("./route");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "99999999-9999-4999-8999-999999999999";

// Receipt ids are real UUIDs: they become the id half of a keyset cursor, and
// decodeCursor pins that half to a UUID so a crafted cursor cannot reach a
// PostgREST filter.
const receiptId = (index: number) => `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`;

function receipt(index: number, overrides: Partial<ReceiptListItemDTO> = {}): ReceiptListItemDTO {
  return {
    receiptId: receiptId(index),
    businessId: "22222222-2222-4222-8222-222222222222",
    businessName: "Kape Diaria",
    status: "approved",
    rejectReason: null,
    merchantName: "KAPE DIARIA",
    receiptNumber: `OR-${index}`,
    receiptDate: "2026-07-24T04:00:00.000Z",
    totalCentavos: 24500,
    createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    processedAt: "2026-07-25T03:15:40.000Z",
    pointsAwarded: 245,
    escalatedAt: null,
    ...overrides,
  };
}

async function callRoute(search = ""): Promise<Response> {
  const request = new NextRequest(`https://giya.test/api/v1/me/receipts${search}`, {
    method: "GET",
  });
  return GET(request);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
  mocks.checkRateLimit.mockResolvedValue({ ok: true, remaining: 119, resetSeconds: 60 });
  mocks.listMyReceipts.mockResolvedValue({ rows: [] });
});

describe("auth", () => {
  it("returns 401 UNAUTHENTICATED with no session and never touches the repository", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(mocks.listMyReceipts).not.toHaveBeenCalled();
  });

  it("CRITICAL: scopes the read to the caller, never to a user id from the request", async () => {
    // There is no way to ask for somebody else's history: the user id is
    // taken from the session, and a query parameter claiming otherwise is
    // simply not part of the schema.
    await callRoute(`?user_id=${OTHER_USER_ID}`);

    expect(mocks.listMyReceipts).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
    );
  });
});

describe("envelope", () => {
  it("wraps the rows in doc 13's { data, meta } envelope with a request_id", async () => {
    mocks.listMyReceipts.mockResolvedValue({ rows: [receipt(0)] });

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.request_id).toBeTruthy();
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("serialises receipts in snake_case with integer centavos", async () => {
    mocks.listMyReceipts.mockResolvedValue({ rows: [receipt(0)] });

    const body = await (await callRoute()).json();

    expect(body.data[0]).toEqual({
      receipt_id: receiptId(0),
      business_id: "22222222-2222-4222-8222-222222222222",
      business_name: "Kape Diaria",
      status: "approved",
      reject_reason: null,
      merchant_name: "KAPE DIARIA",
      receipt_number: "OR-0",
      receipt_date: "2026-07-24T04:00:00.000Z",
      total_centavos: 24500,
      created_at: "2026-07-01T00:00:00.000Z",
      processed_at: "2026-07-25T03:15:40.000Z",
      points_awarded: 245,
      escalated_at: null,
    });
  });

  it("is never cached: it is an authenticated GET and the Realtime poll fallback", async () => {
    const response = await callRoute();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("cursor pagination", () => {
  it("defaults to a limit of 25 and no cursor", async () => {
    await callRoute();

    expect(mocks.listMyReceipts).toHaveBeenCalledWith({
      userId: USER_ID,
      limit: 25,
      cursor: null,
      status: undefined,
    });
  });

  it("over-fetches by one so has_more needs no count query", async () => {
    await callRoute("?limit=3");

    // The repository is asked for limit + 1; the handler trims.
    const args = mocks.listMyReceipts.mock.calls[0]?.[0];
    expect(args.limit).toBe(3);
  });

  it("trims the over-fetched row and reports has_more with a next_cursor", async () => {
    mocks.listMyReceipts.mockResolvedValue({
      rows: [receipt(0), receipt(1), receipt(2), receipt(3)],
    });

    const body = await (await callRoute("?limit=3")).json();

    expect(body.data).toHaveLength(3);
    expect(body.meta.page.has_more).toBe(true);
    expect(body.meta.page.limit).toBe(3);
    expect(decodeCursor(body.meta.page.next_cursor)).toEqual({
      sortKey: "2026-07-03T00:00:00.000Z",
      id: receiptId(2),
    });
  });

  it("reports no next_cursor on the last page", async () => {
    mocks.listMyReceipts.mockResolvedValue({ rows: [receipt(0)] });

    const body = await (await callRoute("?limit=3")).json();

    expect(body.meta.page.has_more).toBe(false);
    expect(body.meta.page.next_cursor).toBeNull();
  });

  it("decodes a supplied cursor into the keyset position the repository needs", async () => {
    const cursor = encodeCursor({ sortKey: "2026-07-03T00:00:00.000Z", id: receiptId(2) });

    await callRoute(`?cursor=${encodeURIComponent(cursor)}`);

    expect(mocks.listMyReceipts).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { sortKey: "2026-07-03T00:00:00.000Z", id: receiptId(2) },
      }),
    );
  });

  it("treats a stale or hand-edited cursor as start-from-head rather than a 422", async () => {
    const response = await callRoute("?cursor=not-a-real-cursor");

    expect(response.status).toBe(200);
    expect(mocks.listMyReceipts).toHaveBeenCalledWith(expect.objectContaining({ cursor: null }));
  });

  it("CRITICAL: a cursor crafted to inject a PostgREST filter never reaches the repository", async () => {
    // The repository splices both cursor components straight into an `.or()`
    // filter, so a sort key carrying `,` or `(` would add filter terms of the
    // caller's choosing. decodeCursor refuses the shape, and the request
    // simply starts from head like any other unusable bookmark: same 200,
    // same answer, nothing learned.
    const crafted = encodeCursor({
      sortKey: "2099-01-01T00:00:00.000Z,user_id.neq.null",
      id: receiptId(2),
    });

    const response = await callRoute(`?cursor=${encodeURIComponent(crafted)}`);

    expect(response.status).toBe(200);
    expect(mocks.listMyReceipts).toHaveBeenCalledWith(expect.objectContaining({ cursor: null }));
  });

  it("rejects a limit above doc 13's clamp", async () => {
    const response = await callRoute("?limit=101");
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(mocks.listMyReceipts).not.toHaveBeenCalled();
  });

  it("rejects a limit below 1 and a non-numeric limit", async () => {
    expect((await callRoute("?limit=0")).status).toBe(422);
    expect((await callRoute("?limit=abc")).status).toBe(422);
  });

  it("accepts no offset parameter: pagination is keyset only", async () => {
    // `offset` is simply not in the schema, so it is ignored rather than
    // honoured. The assertion is that it never reaches the repository.
    await callRoute("?offset=50");

    const args = mocks.listMyReceipts.mock.calls[0]?.[0];
    expect(args).not.toHaveProperty("offset");
  });
});

describe("status filter", () => {
  it.each<ReceiptStatus>(["queued", "processing", "review", "approved", "rejected"])(
    "passes %s through to the repository",
    async (status) => {
      await callRoute(`?status=${status}`);

      expect(mocks.listMyReceipts).toHaveBeenCalledWith(expect.objectContaining({ status }));
    },
  );

  it("rejects a status outside the enum instead of returning a silently empty page", async () => {
    const response = await callRoute("?status=deleted");
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(mocks.listMyReceipts).not.toHaveBeenCalled();
  });

  it("combines the status filter with a cursor", async () => {
    const cursor = encodeCursor({ sortKey: "2026-07-03T00:00:00.000Z", id: receiptId(2) });

    await callRoute(`?status=rejected&limit=5&cursor=${encodeURIComponent(cursor)}`);

    expect(mocks.listMyReceipts).toHaveBeenCalledWith({
      userId: USER_ID,
      limit: 5,
      cursor: { sortKey: "2026-07-03T00:00:00.000Z", id: receiptId(2) },
      status: "rejected",
    });
  });
});

describe("rate limiting", () => {
  it("applies doc 13's general authenticated ceiling of 120/min per user", async () => {
    await callRoute();

    expect(mocks.checkRateLimit).toHaveBeenCalledWith({
      key: `test:rl:me.receipts.list:user:${USER_ID}`,
      limit: 120,
      windowSeconds: 60,
    });
  });

  it("returns 429 with Retry-After when the limiter blocks", async () => {
    mocks.checkRateLimit.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 17 });

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(response.headers.get("Retry-After")).toBe("17");
    expect(mocks.listMyReceipts).not.toHaveBeenCalled();
  });
});

describe("no fraud internals in the response body", () => {
  it("emits exactly the fields the client is granted, whatever the repository returns", async () => {
    // A repository row polluted with the columns 0017 withholds. The wire
    // mapper builds the body field by field, so none of them can appear.
    mocks.listMyReceipts.mockResolvedValue({
      rows: [
        {
          ...receipt(0, { status: "rejected", rejectReason: "fraud_suspected" }),
          ...({
            rejectNote: "matched receipt 8f21 from Ana Cruz",
            reject_note: "matched receipt 8f21 from Ana Cruz",
            parseMeta: { total: { tier: "llm", conf: 0.41 } },
            matchConfidence: 0.62,
            parseConfidence: 0.44,
            sha256: "9f86d081884c7d659a2feaa0c55ad015a",
            imageHash: "c0ffee1234567890",
            imagePath: `${USER_ID}/abc.jpg`,
          } as Record<string, unknown>),
        },
      ],
    });

    const response = await callRoute();
    const raw = await response.text();
    const body = JSON.parse(raw);

    expect(Object.keys(body.data[0]).sort()).toEqual([
      "business_id",
      "business_name",
      "created_at",
      "escalated_at",
      "merchant_name",
      "points_awarded",
      "processed_at",
      "receipt_date",
      "receipt_id",
      "receipt_number",
      "reject_reason",
      "status",
      "total_centavos",
    ]);

    expect(raw).not.toContain("Ana Cruz");
    expect(raw).not.toContain("8f21");
    expect(raw).not.toContain("9f86d081");
    expect(raw).not.toContain("c0ffee");
    expect(raw).not.toContain("reject_note");
    expect(raw).not.toContain("parse_meta");
    expect(raw).not.toContain("confidence");
    expect(raw).not.toContain("image_path");
    expect(raw).not.toContain("image_hash");
  });
});
