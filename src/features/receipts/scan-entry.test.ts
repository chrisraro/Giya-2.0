import { describe, it, expect } from "vitest";

import {
  MAX_STORE_QUERY_LENGTH,
  parseBusinessIdParam,
  parseStoreQueryParam,
  shouldShowOcrStubNote,
} from "./scan-entry";

const BUSINESS_ID = "3f1b0d9c-4444-4444-8444-444444444444";

describe("parseBusinessIdParam", () => {
  it("accepts a UUID from the business page Scan CTA", () => {
    expect(parseBusinessIdParam(BUSINESS_ID)).toBe(BUSINESS_ID);
  });

  it("normalises case and surrounding whitespace", () => {
    expect(parseBusinessIdParam(` ${BUSINESS_ID.toUpperCase()} `)).toBe(BUSINESS_ID);
  });

  it("takes the first value when the param is repeated", () => {
    expect(parseBusinessIdParam([BUSINESS_ID, "other"])).toBe(BUSINESS_ID);
  });

  it("drops a non-UUID rather than forwarding it to the API", () => {
    // A junk value would only fail Zod validation at submit time, after the
    // consumer had already taken the photo. Undefined is NOT a generic scan:
    // generic scan is [V1] and an unbound receipt hard-rejects, so /scan reads
    // undefined as "show the store chooser".
    expect(parseBusinessIdParam("not-a-uuid")).toBeUndefined();
    expect(parseBusinessIdParam("")).toBeUndefined();
    expect(parseBusinessIdParam(undefined)).toBeUndefined();
  });
});

describe("parseStoreQueryParam", () => {
  it("keeps a normal shop search", () => {
    expect(parseStoreQueryParam("Kape Diaria")).toBe("Kape Diaria");
  });

  it("trims and collapses whitespace", () => {
    expect(parseStoreQueryParam("  kape   diaria  ")).toBe("kape diaria");
  });

  it("keeps the punctuation real shop names use", () => {
    expect(parseStoreQueryParam("Tita's Lugaw & Grill-2")).toBe("Tita's Lugaw & Grill-2");
  });

  it("CRITICAL: strips ilike wildcards and PostgREST filter punctuation", () => {
    // The value lands in `.ilike("name", `%${query}%`)`. A `%` or `_` would
    // reshape the pattern; a `,` `(` `)` or `.` is PostgREST filter grammar.
    expect(parseStoreQueryParam("kape%_diaria")).toBe("kape diaria");
    expect(parseStoreQueryParam("kape,status.eq.active")).toBe("kape status eq active");
    expect(parseStoreQueryParam("a),or(deleted_at.not.is.null")).toBe(
      "a or deleted at not is null",
    );
  });

  it("caps the length so a megabyte of junk never reaches the database", () => {
    const result = parseStoreQueryParam("a".repeat(500));

    expect(result).toBe("a".repeat(MAX_STORE_QUERY_LENGTH));
  });

  it("returns undefined for nothing usable, which reads as no active search", () => {
    expect(parseStoreQueryParam(undefined)).toBeUndefined();
    expect(parseStoreQueryParam("")).toBeUndefined();
    expect(parseStoreQueryParam("   ")).toBeUndefined();
    expect(parseStoreQueryParam("%%%")).toBeUndefined();
  });

  it("takes the first value when the param is repeated", () => {
    expect(parseStoreQueryParam(["kape", "lugaw"])).toBe("kape");
  });
});

describe("shouldShowOcrStubNote", () => {
  it("shows the note in development when OCR_SERVICE_URL is unset", () => {
    expect(shouldShowOcrStubNote({ nodeEnv: "development", ocrServiceUrl: undefined })).toBe(true);
  });

  it("treats a blank OCR_SERVICE_URL as unset, matching the env loader", () => {
    expect(shouldShowOcrStubNote({ nodeEnv: "development", ocrServiceUrl: "   " })).toBe(true);
  });

  it("hides the note when the real OCR container is configured", () => {
    expect(
      shouldShowOcrStubNote({ nodeEnv: "development", ocrServiceUrl: "https://ocr.example" }),
    ).toBe(false);
  });

  it("never shows the note in production, whatever the configuration", () => {
    expect(shouldShowOcrStubNote({ nodeEnv: "production", ocrServiceUrl: undefined })).toBe(false);
    expect(shouldShowOcrStubNote({ nodeEnv: "production", ocrServiceUrl: "" })).toBe(false);
  });
});
