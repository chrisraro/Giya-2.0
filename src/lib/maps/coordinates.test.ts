import { describe, expect, it } from "vitest";

import {
  COORDINATE_PRECISION,
  DIRECTIONS_BASE_URL,
  directionsUrl,
  formatCoordinates,
  isInsidePhilippines,
  isValidCoordinates,
  isValidLatitude,
  isValidLongitude,
  PHILIPPINES_BOUNDS,
  roundCoordinate,
} from "./coordinates";

const CEBU = { lat: 10.3156, lng: 123.8854 };

describe("coordinate ranges", () => {
  it.each([0, 90, -90, 10.3156])("accepts %s as a latitude", (value) => {
    expect(isValidLatitude(value)).toBe(true);
  });

  it.each([90.000001, -90.000001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuses %s as a latitude",
    (value) => {
      expect(isValidLatitude(value)).toBe(false);
    },
  );

  it.each([0, 180, -180, 123.8854])("accepts %s as a longitude", (value) => {
    expect(isValidLongitude(value)).toBe(true);
  });

  it.each([180.000001, -180.000001, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s as a longitude",
    (value) => {
      expect(isValidLongitude(value)).toBe(false);
    },
  );

  it("refuses a transposed Philippine pair without needing a country box", () => {
    // The point of the range check: every Philippine longitude exceeds 116, so
    // a swap always lands a latitude outside [-90, 90].
    expect(isValidCoordinates({ lat: CEBU.lng, lng: CEBU.lat })).toBe(false);
    expect(isValidCoordinates(CEBU)).toBe(true);
  });
});

describe("rounding", () => {
  it("keeps six decimals, which is finer than any shopfront needs", () => {
    expect(roundCoordinate(10.315612345678901)).toBe(10.315612);
    expect(COORDINATE_PRECISION).toBe(6);
  });

  it("rounds rather than truncating", () => {
    expect(roundCoordinate(123.8854987)).toBe(123.885499);
  });

  it("does not reintroduce float noise the way a multiply/divide pair does", () => {
    // The naive `Math.round(v * 1e6) / 1e6` is what this guards against.
    expect(String(roundCoordinate(10.3156))).toBe("10.3156");
  });

  it("leaves an already-short value alone", () => {
    expect(roundCoordinate(10.3156)).toBe(10.3156);
    expect(roundCoordinate(0)).toBe(0);
  });
});

describe("the Philippines box", () => {
  it.each([
    ["Cebu", CEBU],
    ["Metro Manila", { lat: 14.5995, lng: 120.9842 }],
    ["Batanes", { lat: 20.45, lng: 121.97 }],
    ["Tawi-Tawi", { lat: 5.04, lng: 119.79 }],
  ])("puts %s inside", (_label, value) => {
    expect(isInsidePhilippines(value)).toBe(true);
  });

  it.each([
    ["Singapore", { lat: 1.3521, lng: 103.8198 }],
    ["Tokyo", { lat: 35.6762, lng: 139.6503 }],
    ["the null island", { lat: 0, lng: 0 }],
  ])("puts %s outside", (_label, value) => {
    expect(isInsidePhilippines(value)).toBe(false);
  });

  it("is a hint and not a validity rule: outside the box is still a valid coordinate", () => {
    const singapore = { lat: 1.3521, lng: 103.8198 };
    expect(isInsidePhilippines(singapore)).toBe(false);
    expect(isValidCoordinates(singapore)).toBe(true);
  });

  it("is looser than the land area, so a coastal shop is never flagged", () => {
    expect(PHILIPPINES_BOUNDS.south).toBeLessThan(4.5);
    expect(PHILIPPINES_BOUNDS.north).toBeGreaterThan(21.2);
    expect(PHILIPPINES_BOUNDS.west).toBeLessThan(116.9);
    expect(PHILIPPINES_BOUNDS.east).toBeGreaterThan(126.6);
  });
});

describe("formatting", () => {
  it("pads both numbers to a fixed width so they line up in a column", () => {
    expect(formatCoordinates(CEBU)).toBe("10.315600, 123.885400");
  });

  it("keeps the sign on southern and western coordinates", () => {
    expect(formatCoordinates({ lat: -33.8688, lng: -151.2093 })).toBe("-33.868800, -151.209300");
  });
});

describe("the directions link", () => {
  it("is a plain https Google Maps universal link", () => {
    const url = directionsUrl(CEBU);

    // Not `geo:` (dead on iOS and desktop), not `maps://` (dead everywhere but
    // Apple). This one is intercepted by the installed app on both phone
    // platforms and is a working web page when there is no app.
    expect(url.startsWith("https://")).toBe(true);
    expect(url.startsWith(DIRECTIONS_BASE_URL)).toBe(true);
  });

  it("uses the documented api=1 contract with the destination as coordinates", () => {
    const url = new URL(directionsUrl(CEBU));

    expect(url.searchParams.get("api")).toBe("1");
    expect(url.searchParams.get("destination")).toBe("10.3156,123.8854");
  });

  it("rounds the destination, so two saves of the same pin produce the same link", () => {
    const url = new URL(directionsUrl({ lat: 10.315612345678, lng: 123.885498765 }));

    expect(url.searchParams.get("destination")).toBe("10.315612,123.885499");
  });

  it("encodes the destination rather than trusting the comma", () => {
    expect(directionsUrl(CEBU)).toContain("destination=10.3156%2C123.8854");
  });

  it("survives a round trip through URL parsing for southern hemisphere pins", () => {
    const url = new URL(directionsUrl({ lat: -8.5, lng: 125.5 }));

    expect(url.searchParams.get("destination")).toBe("-8.5,125.5");
  });
});
