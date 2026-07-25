import { describe, it, expect } from "vitest";

import { parseBusinessIdParam, shouldShowOcrStubNote } from "./scan-entry";

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
    // consumer had already taken the photo. Dropping it degrades to a generic
    // scan, which business matching resolves anyway.
    expect(parseBusinessIdParam("not-a-uuid")).toBeUndefined();
    expect(parseBusinessIdParam("")).toBeUndefined();
    expect(parseBusinessIdParam(undefined)).toBeUndefined();
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
