import { describe, expect, it } from "vitest";
import {
  ACTUAL_PIXELS_PER_WORLD_METER,
  mediaDisplayLayout,
  mediaScaleForPanel,
  nativeMediaSize,
} from "../../app/src/core/media-display.js";

describe("media display layouts", () => {
  it("keeps a constant pixel density of 1000 px per world metre", () => {
    expect(ACTUAL_PIXELS_PER_WORLD_METER).toBe(1000);
    expect(nativeMediaSize({ sourceWidth: 400, sourceHeight: 200 })).toEqual({
      width: 0.4,
      height: 0.2,
    });
  });

  it("scales the native surface with an optional user scale", () => {
    expect(nativeMediaSize({ sourceWidth: 1000, sourceHeight: 500, scale: 2 })).toEqual({
      width: 2,
      height: 1,
    });
    // Invalid scales fall back to 1.
    expect(nativeMediaSize({ sourceWidth: 1000, sourceHeight: 500, scale: Number.NaN })).toEqual({
      width: 1,
      height: 0.5,
    });
  });

  it("returns identity UVs and centered position for full-scale media", () => {
    const layout = mediaDisplayLayout({ sourceWidth: 1600, sourceHeight: 900 });
    expect(layout).toEqual({
      surface: { width: 1.6, height: 0.9 },
      position: { x: 0, y: 0 },
      uv: { repeat: { x: 1, y: 1 }, offset: { x: 0, y: 0 } },
    });
  });

  it("uniformly scales native-aspect media with the panel dimensions", () => {
    expect(mediaScaleForPanel({
      sourceWidth: 1600,
      sourceHeight: 900,
      panelWidth: 3.2,
      panelHeight: 1.8,
    })).toBe(2);
    expect(mediaDisplayLayout({
      sourceWidth: 1600,
      sourceHeight: 900,
      panelWidth: 3.2,
      panelHeight: 1.8,
    }).surface).toEqual({ width: 3.2, height: 1.8 });
  });

  it("fits mismatched panel dimensions without distorting native aspect ratio", () => {
    expect(mediaDisplayLayout({
      sourceWidth: 1600,
      sourceHeight: 900,
      panelWidth: 2,
      panelHeight: 2,
    }).surface).toEqual({ width: 2, height: 1.125 });
  });

  it("uses finite positive fallbacks for invalid dimensions", () => {
    expect(nativeMediaSize({ sourceWidth: -20, sourceHeight: Infinity })).toEqual({
      width: 0.001,
      height: 0.001,
    });
  });
});
