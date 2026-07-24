import { describe, it, expect } from "vitest";
import { toErrorMessage } from "./error-message";

describe("toErrorMessage", () => {
  it("returns the message of an Error instance", () => {
    expect(toErrorMessage(new Error("Invalid login credentials"))).toBe(
      "Invalid login credentials",
    );
  });

  it("falls back when message is an empty string", () => {
    expect(toErrorMessage({ message: "" })).toBe("Something went wrong. Please try again.");
  });

  it("falls back for a plain object with no usable message", () => {
    expect(toErrorMessage({ foo: "bar" })).toBe("Something went wrong. Please try again.");
    expect(toErrorMessage({})).toBe("Something went wrong. Please try again.");
  });

  it("returns a non-empty string input as-is", () => {
    expect(toErrorMessage("network request failed")).toBe("network request failed");
  });

  it("falls back for an empty string input", () => {
    expect(toErrorMessage("")).toBe("Something went wrong. Please try again.");
  });

  it("falls back for null and undefined", () => {
    expect(toErrorMessage(null)).toBe("Something went wrong. Please try again.");
    expect(toErrorMessage(undefined)).toBe("Something went wrong. Please try again.");
  });

  it("returns a non-empty string message on a plain (non-Error) object", () => {
    expect(toErrorMessage({ message: "duplicate business" })).toBe("duplicate business");
  });
});
