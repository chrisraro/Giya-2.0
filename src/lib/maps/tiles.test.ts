import { describe, expect, it } from "vitest";

import {
  buildTileUrl,
  MERCATOR_LATITUDE_LIMIT,
  projectToWorldPixels,
  staticMapLayout,
  TILE_SIZE,
  unprojectFromWorldPixels,
  worldSize,
} from "./tiles";

const CEBU = { lat: 10.3156, lng: 123.8854 };

describe("the Mercator projection", () => {
  it("puts (0, 0) at the exact centre of the world", () => {
    const size = worldSize(3);
    expect(projectToWorldPixels({ lat: 0, lng: 0 }, 3)).toEqual({ x: size / 2, y: size / 2 });
  });

  it("puts the antimeridian at both edges", () => {
    const size = worldSize(2);
    expect(projectToWorldPixels({ lat: 0, lng: -180 }, 2).x).toBeCloseTo(0);
    expect(projectToWorldPixels({ lat: 0, lng: 180 }, 2).x).toBeCloseTo(size);
  });

  it("doubles the world with every zoom level", () => {
    expect(worldSize(0)).toBe(TILE_SIZE);
    expect(worldSize(1)).toBe(TILE_SIZE * 2);
    expect(worldSize(10)).toBe(TILE_SIZE * 1024);
  });

  it("round-trips a real coordinate", () => {
    const back = unprojectFromWorldPixels(projectToWorldPixels(CEBU, 17), 17);

    expect(back.lat).toBeCloseTo(CEBU.lat, 9);
    expect(back.lng).toBeCloseTo(CEBU.lng, 9);
  });

  it("clamps at the poles rather than emitting Infinity into a style attribute", () => {
    // The log term diverges past the Mercator limit; an unclamped implementation
    // would put `top: Infinity` on a tile and paint nothing at all.
    const northPole = projectToWorldPixels({ lat: 90, lng: 0 }, 5);
    const limit = projectToWorldPixels({ lat: MERCATOR_LATITUDE_LIMIT, lng: 0 }, 5);

    expect(Number.isFinite(northPole.y)).toBe(true);
    expect(northPole.y).toBeCloseTo(limit.y, 6);
  });
});

describe("the static map layout", () => {
  const FRAME = { width: 512, height: 224 };

  it("puts the pin at the exact centre of the frame", () => {
    const layout = staticMapLayout({ center: CEBU, zoom: 17, ...FRAME });

    expect(layout.pinLeft).toBe(256);
    expect(layout.pinTop).toBe(112);
  });

  it("covers the whole frame with no gap on any side", () => {
    const layout = staticMapLayout({ center: CEBU, zoom: 17, ...FRAME });

    const left = Math.min(...layout.tiles.map((tile) => tile.left));
    const top = Math.min(...layout.tiles.map((tile) => tile.top));
    const right = Math.max(...layout.tiles.map((tile) => tile.left + TILE_SIZE));
    const bottom = Math.max(...layout.tiles.map((tile) => tile.top + TILE_SIZE));

    expect(left).toBeLessThanOrEqual(0);
    expect(top).toBeLessThanOrEqual(0);
    expect(right).toBeGreaterThanOrEqual(FRAME.width);
    expect(bottom).toBeGreaterThanOrEqual(FRAME.height);
  });

  it("stays within the tile budget the free-tier maths is based on", () => {
    // src/lib/maps/tile-source.ts reasons about the monthly quota from "six
    // tiles in the common case, never more than eight". If this changes, that
    // budget is wrong and the comment there has to change with it.
    for (let step = 0; step < 40; step += 1) {
      const layout = staticMapLayout({
        center: { lat: 4 + step * 0.43, lng: 116 + step * 0.27 },
        zoom: 17,
        ...FRAME,
      });
      expect(layout.tiles.length).toBeLessThanOrEqual(8);
    }
  });

  it("gives every tile a unique key", () => {
    const layout = staticMapLayout({ center: CEBU, zoom: 17, ...FRAME });
    const ids = new Set(layout.tiles.map((tile) => tile.id));

    expect(ids.size).toBe(layout.tiles.length);
  });

  it("wraps the tile column across the antimeridian while keeping the offset continuous", () => {
    const layout = staticMapLayout({ center: { lat: 0, lng: 180 }, zoom: 2, ...FRAME });
    const columns = 2 ** 2;

    // Every REQUESTED column is a real one...
    for (const tile of layout.tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(columns);
    }
    // ...and the offsets still run in an unbroken sequence, so the seam paints
    // continuously rather than showing a gap where column -1 would have been.
    const lefts = Array.from(new Set(layout.tiles.map((tile) => tile.left))).sort((a, b) => a - b);
    for (let index = 1; index < lefts.length; index += 1) {
      expect((lefts[index] ?? 0) - (lefts[index - 1] ?? 0)).toBe(TILE_SIZE);
    }
  });

  it("drops tile rows that do not exist rather than requesting broken images", () => {
    // Latitude does not wrap. A frame at the top of the world asks for row -1,
    // which is not imagery that exists anywhere.
    const layout = staticMapLayout({ center: { lat: 85, lng: 0 }, zoom: 1, ...FRAME });

    for (const tile of layout.tiles) {
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeLessThan(2 ** 1);
    }
  });

  it("rounds a fractional zoom rather than requesting a tile path with a decimal in it", () => {
    const layout = staticMapLayout({ center: CEBU, zoom: 16.4, ...FRAME });

    expect(layout.zoom).toBe(16);
    expect(layout.tiles.every((tile) => Number.isInteger(tile.z))).toBe(true);
  });
});

describe("the tile URL template", () => {
  it("fills z, x and y", () => {
    expect(buildTileUrl("https://tiles.test/{z}/{x}/{y}.png", { z: 17, x: 3, y: 4 })).toBe(
      "https://tiles.test/17/3/4.png",
    );
  });

  it("leaves a provider's own query string alone", () => {
    expect(
      buildTileUrl("https://tiles.test/a/256/{z}/{x}/{y}.png?key=abc", { z: 1, x: 2, y: 3 }),
    ).toBe("https://tiles.test/a/256/1/2/3.png?key=abc");
  });
});
