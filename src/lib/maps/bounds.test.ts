import { describe, expect, it } from "vitest";

import { fitBounds } from "./bounds";
import { projectToWorldPixels } from "./tiles";

// The arithmetic that turns "these shops" into "this frame". Every expected
// value below is a literal worked out by hand from the Web Mercator formulae,
// never re-derived from the module under test, so a wrong implementation cannot
// agree with its own expectation.

const FRAME_WIDTH = 512;
const FRAME_HEIGHT = 224;

describe("fitBounds", () => {
  it("reports no frame at all when there is nothing to show", () => {
    // Not a centre on Null Island with a default zoom: the caller has to be
    // able to tell "no shops have pins" from "the shops are near 0,0", because
    // the first means render no map and the second means render one.
    expect(
      fitBounds({
        points: [],
        width: FRAME_WIDTH,
        height: FRAME_HEIGHT,
        minZoom: 2,
        maxZoom: 15,
      }),
    ).toBeNull();
  });

  it("centres on the only point and zooms all the way in when there is one", () => {
    const result = fitBounds({
      points: [{ lat: 10.3156, lng: 123.8854 }],
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      minZoom: 2,
      maxZoom: 15,
    });

    expect(result?.center.lat).toBeCloseTo(10.3156, 6);
    expect(result?.center.lng).toBeCloseTo(123.8854, 6);
    // A zero-span box fits at any zoom, so the answer is the closest look the
    // caller allows rather than the widest.
    expect(result?.zoom).toBe(15);
  });

  it("zooms all the way in when every shop sits on the same pin", () => {
    const same = { lat: 14.5995, lng: 120.9842 };
    const result = fitBounds({
      points: [same, same, same],
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      minZoom: 2,
      maxZoom: 15,
    });

    expect(result?.zoom).toBe(15);
    expect(result?.center.lat).toBeCloseTo(14.5995, 6);
  });

  it("picks the largest whole zoom at which the longitude span still fits", () => {
    // At zoom 0 the world is 256px wide, so x = ((lng + 180) / 360) * 256.
    //   lng -45 -> 96          lng 44 -> 159.28889
    // span 63.28889px, and 512 / 63.28889 = 8.08995, log2 = 3.01614.
    // Floored, not rounded: zoom 4 would be 2x too close and clip both shops.
    const result = fitBounds({
      points: [
        { lat: 0, lng: -45 },
        { lat: 0, lng: 44 },
      ],
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      minZoom: 0,
      maxZoom: 15,
    });

    expect(result?.zoom).toBe(3);
    expect(result?.center.lng).toBeCloseTo(-0.5, 6);
    expect(result?.center.lat).toBeCloseTo(0, 6);
  });

  it("lets the latitude span decide when it is the tighter of the two", () => {
    // Same longitude, so the x span is zero and only the 224px height can
    // constrain the answer. y = (0.5 - ln((1+sin)/(1-sin)) / 4pi) * 256:
    //   lat 5 -> 124.4394      lat -5 -> 131.5606
    // span 7.1212px, and 224 / 7.1212 = 31.4554, log2 = 4.9752 -> 4.
    const result = fitBounds({
      points: [
        { lat: 5, lng: 120 },
        { lat: -5, lng: 120 },
      ],
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      minZoom: 0,
      maxZoom: 15,
    });

    expect(result?.zoom).toBe(4);
  });

  it("centres in projected space, not on the average of the two latitudes", () => {
    // Mercator stretches towards the poles, so the midpoint of the PICTURE is
    // not the midpoint of the numbers. lat 0 -> y 128, lat 60 -> y 74.3388;
    // the midpoint y 101.1694 unprojects to 35.2644, not to 30. Getting this
    // wrong tilts every multi-shop frame towards the equator.
    const result = fitBounds({
      points: [
        { lat: 0, lng: 121 },
        { lat: 60, lng: 121 },
      ],
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      minZoom: 0,
      maxZoom: 15,
    });

    expect(result?.center.lat).toBeCloseTo(35.2644, 3);
    expect(result?.center.lng).toBeCloseTo(121, 6);
  });

  it("gives back the padding, so a pin near the edge is not sliced in half", () => {
    // The same 63.28889px span as the longitude case, but only 512 - 2*64 =
    // 384px of frame may be used: 384 / 63.28889 = 6.0674, log2 = 2.6011 -> 2.
    const result = fitBounds({
      points: [
        { lat: 0, lng: -45 },
        { lat: 0, lng: 44 },
      ],
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      minZoom: 0,
      maxZoom: 15,
      padding: 64,
    });

    expect(result?.zoom).toBe(2);
  });

  it("never zooms out past the floor the caller set, however far apart the shops are", () => {
    // lng -170 to 170 spans 248.888px at zoom 0, which wants zoom 1. A browse
    // map of the whole planet is not more useful than a map that crops.
    const result = fitBounds({
      points: [
        { lat: 0, lng: -170 },
        { lat: 0, lng: 170 },
      ],
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      minZoom: 3,
      maxZoom: 15,
    });

    expect(result?.zoom).toBe(3);
  });

  it("holds every point inside the frame it chose", () => {
    // The property the literals above are individual cases of, checked against
    // a scatter of real Philippine cities rather than a contrived pair.
    const points = [
      { lat: 14.5995, lng: 120.9842 }, // Manila
      { lat: 10.3157, lng: 123.8854 }, // Cebu City
      { lat: 7.1907, lng: 125.4553 }, // Davao
      { lat: 16.4023, lng: 120.596 }, // Baguio
    ];

    const result = fitBounds({
      points,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      minZoom: 0,
      maxZoom: 15,
      padding: 24,
    });

    const zoom = result?.zoom ?? 0;
    const origin = projectToWorldPixels(result?.center ?? { lat: 0, lng: 0 }, zoom);

    for (const point of points) {
      const pixel = projectToWorldPixels(point, zoom);
      expect(Math.abs(pixel.x - origin.x)).toBeLessThanOrEqual(FRAME_WIDTH / 2 - 24);
      expect(Math.abs(pixel.y - origin.y)).toBeLessThanOrEqual(FRAME_HEIGHT / 2 - 24);
    }
  });
});
