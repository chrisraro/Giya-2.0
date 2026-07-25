import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ApiError,
  API_ERROR_CODES,
  badRequest,
  conflict,
  dependencyUnavailable,
  forbidden,
  internal,
  isApiError,
  notFound,
  rateLimited,
  unauthenticated,
  unprocessable,
  validationFailed,
  zodIssuesToDetails,
} from "./errors";

describe("ApiError", () => {
  it("carries status, code, message and optional details", () => {
    const error = new ApiError(422, "RECEIPT_DUPLICATE", "Already submitted.", [
      { field: "receipt_number", issue: "duplicate" },
    ]);

    expect(error.status).toBe(422);
    expect(error.code).toBe("RECEIPT_DUPLICATE");
    expect(error.message).toBe("Already submitted.");
    expect(error.details).toEqual([{ field: "receipt_number", issue: "duplicate" }]);
    expect(error).toBeInstanceOf(Error);
  });

  it("isApiError distinguishes it from an ordinary Error", () => {
    expect(isApiError(new ApiError(500, "INTERNAL", "x"))).toBe(true);
    expect(isApiError(new Error("x"))).toBe(false);
    expect(isApiError("not an error")).toBe(false);
    expect(isApiError(null)).toBe(false);
  });
});

describe("error constructors map to doc 13's registry", () => {
  it("uses the registered status for each code", () => {
    expect([badRequest("x").status, badRequest("x").code]).toEqual([400, "BAD_REQUEST"]);
    expect([unauthenticated().status, unauthenticated().code]).toEqual([401, "UNAUTHENTICATED"]);
    expect([forbidden().status, forbidden().code]).toEqual([403, "FORBIDDEN"]);
    expect([notFound().status, notFound().code]).toEqual([404, "NOT_FOUND"]);
    expect([conflict("CAMPAIGN_INVALID_STATE", "x").status, conflict("C", "x").code]).toEqual([
      409,
      "C",
    ]);
    expect([validationFailed([]).status, validationFailed([]).code]).toEqual([
      422,
      "VALIDATION_FAILED",
    ]);
    expect([unprocessable("POINTS_INSUFFICIENT", "x").status]).toEqual([422]);
    expect([rateLimited().status, rateLimited().code]).toEqual([429, "RATE_LIMITED"]);
    expect([internal().status, internal().code]).toEqual([500, "INTERNAL"]);
    expect([dependencyUnavailable().status, dependencyUnavailable().code]).toEqual([
      503,
      "DEPENDENCY_UNAVAILABLE",
    ]);
  });

  it("lets a domain module supply its own registered code at 400 or 409", () => {
    expect(badRequest("x", API_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED).code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    expect(conflict("REWARD_OUT_OF_STOCK", "Sold out.").code).toBe("REWARD_OUT_OF_STOCK");
  });
});

describe("zodIssuesToDetails", () => {
  function issuesFor(schema: z.ZodType, value: unknown) {
    const parsed = schema.safeParse(value);
    if (parsed.success) {
      throw new Error("expected the schema to reject this value");
    }
    return zodIssuesToDetails(parsed.error);
  }

  it("emits one { field, issue } entry per problem", () => {
    const details = issuesFor(
      z.object({ receipt_number: z.string(), total_centavos: z.number() }),
      { receipt_number: 1, total_centavos: "x" },
    );

    expect(details).toHaveLength(2);
    expect(details.map((detail) => detail.field).sort()).toEqual([
      "receipt_number",
      "total_centavos",
    ]);
    for (const detail of details) {
      expect(Object.keys(detail)).toEqual(["field", "issue"]);
      expect(detail.issue).toBe("invalid_type");
    }
  });

  it("dots nested paths and includes array indices", () => {
    const details = issuesFor(
      z.object({ lines: z.array(z.object({ qty: z.number() })) }),
      { lines: [{ qty: 1 }, { qty: "two" }] },
    );

    expect(details[0]?.field).toBe("lines.1.qty");
  });

  it("labels a whole-body problem rather than emitting an empty field", () => {
    const details = issuesFor(z.object({ a: z.string() }), "not an object");

    expect(details[0]?.field).toBe("_root");
  });

  it("never forwards Zod's own prose, which can echo the caller's input", () => {
    const details = issuesFor(
      z.object({ secret: z.literal("expected-value") }),
      { secret: "sk_live_leaked_token" },
    );

    expect(JSON.stringify(details)).not.toContain("sk_live_leaked_token");
    expect(JSON.stringify(details)).not.toContain("expected-value");
  });
});
