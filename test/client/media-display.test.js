import { describe, expect, it } from "vitest";
import {
  ACTUAL_PIXELS_PER_WORLD_METER,
  DEFAULT_DISPLAY_MODE,
  DISPLAY_MODES,
  actualMediaLayout,
  fillMediaUv,
  fitMediaSize,
  mediaDisplayLayout,
  mediaDisplayTransform,
  nextDisplayMode,
  normalizeDisplayMode,
} from "../../app/src/core/media-display.js";

describe("media display layouts", () => {
  it("defaults safely to fit and cycles actual, fill, then fit", () => {
    expect(DEFAULT_DISPLAY_MODE).toBe(DISPLAY_MODES.FIT);
    expect(normalizeDisplayMode("unknown")).toBe(DISPLAY_MODES.FIT);
    expect(nextDisplayMode(DISPLAY_MODES.ACTUAL)).toBe(DISPLAY_MODES.FILL);
    expect(nextDisplayMode(DISPLAY_MODES.FILL)).toBe(DISPLAY_MODES.FIT);
    expect(nextDisplayMode(DISPLAY_MODES.FIT)).toBe(DISPLAY_MODES.ACTUAL);
    expect(nextDisplayMode("unknown")).toBe(DISPLAY_MODES.ACTUAL);
  });

  it("keeps the media display transform alias equivalent to the layout helper", () => {
    const options = {
      mode: DISPLAY_MODES.FILL,
      panelWidth: 4,
      panelHeight: 3,
      sourceWidth: 16,
      sourceHeight: 9,
      contentZoom: 2,
      contentPan: { x: 0.1, y: -0.1 },
    };
    expect(mediaDisplayTransform(options)).toEqual(mediaDisplayLayout(options));
  });

  it("contains fit media at the correct aspect ratio", () => {
    expect(fitMediaSize({
      panelWidth: 4,
      panelHeight: 3,
      sourceWidth: 16,
      sourceHeight: 9,
    })).toEqual({ width: 4, height: 2.25 });

    const layout = mediaDisplayLayout({
      panelWidth: 4,
      panelHeight: 3,
      sourceWidth: 16,
      sourceHeight: 9,
    });
    expect(layout).toMatchObject({
      mode: DISPLAY_MODES.FIT,
      surface: { width: 4, height: 2.25 },
      uv: { repeat: { x: 1, y: 1 }, offset: { x: 0, y: 0 } },
    });
    expect(layout.position.x).toBeCloseTo(0);
    expect(layout.position.y).toBeCloseTo(0);
  });

  it("fills the panel with a centered, non-repeating UV crop", () => {
    expect(fillMediaUv({
      panelWidth: 4,
      panelHeight: 3,
      sourceWidth: 16,
      sourceHeight: 9,
    })).toEqual({
      repeat: { x: 0.75, y: 1 },
      offset: { x: 0.125, y: 0 },
    });

    const layout = mediaDisplayLayout({
      mode: DISPLAY_MODES.FILL,
      panelWidth: 4,
      panelHeight: 3,
      sourceWidth: 16,
      sourceHeight: 9,
    });
    expect(layout.surface).toEqual({ width: 4, height: 3 });
    expect(layout.uv).toEqual({
      repeat: { x: 0.75, y: 1 },
      offset: { x: 0.125, y: 0 },
    });
  });

  it("keeps actual media at a constant pixel density, centering small media and cropping large media", () => {
    expect(ACTUAL_PIXELS_PER_WORLD_METER).toBe(1000);
    expect(actualMediaLayout({
      panelWidth: 1.2,
      panelHeight: 0.8,
      sourceWidth: 400,
      sourceHeight: 200,
    })).toEqual({
      surface: { width: 0.4, height: 0.2 },
      uv: { repeat: { x: 1, y: 1 }, offset: { x: 0, y: 0 } },
    });

    const cropped = actualMediaLayout({
      panelWidth: 1.2,
      panelHeight: 0.8,
      sourceWidth: 2400,
      sourceHeight: 1600,
    });
    expect(cropped.surface).toEqual({ width: 1.2, height: 0.8 });
    expect(cropped.uv).toEqual({
      repeat: { x: 0.5, y: 0.5 },
      offset: { x: 0.25, y: 0.25 },
    });
    expect(cropped.uv.repeat.x).toBeLessThanOrEqual(1);
    expect(cropped.uv.repeat.y).toBeLessThanOrEqual(1);
  });

  it("layers content zoom and pan around the center without allowing UV repeats", () => {
    const layout = mediaDisplayLayout({
      mode: DISPLAY_MODES.FIT,
      panelWidth: 4,
      panelHeight: 3,
      sourceWidth: 16,
      sourceHeight: 9,
      contentZoom: 2,
      contentPan: { x: 0.1, y: 0.1 },
    });
    expect(layout.surface).toEqual({ width: 4, height: 2.25 });
    expect(layout.position.x).toBeCloseTo(0);
    expect(layout.position.y).toBeCloseTo(0.3);
    expect(layout.uv).toEqual({
      repeat: { x: 0.5, y: 0.5 },
      offset: { x: 0.15, y: 0.35 },
    });
    expect(layout.uv.repeat.x).toBeLessThanOrEqual(1);
    expect(layout.uv.repeat.y).toBeLessThanOrEqual(1);
  });

  it("uses finite positive fallbacks for invalid dimensions and modes", () => {
    const layout = mediaDisplayLayout({
      mode: null,
      panelWidth: 0,
      panelHeight: Number.NaN,
      sourceWidth: -20,
      sourceHeight: Infinity,
      contentZoom: Number.NaN,
      contentPan: { x: Infinity, y: Number.NaN },
    });
    expect(layout.mode).toBe(DISPLAY_MODES.FIT);
    expect(layout.surface).toEqual({ width: 1, height: 1 });
    expect(layout.position.x).toBeCloseTo(0);
    expect(layout.position.y).toBeCloseTo(0);
    expect(layout.uv).toEqual({
      repeat: { x: 1, y: 1 },
      offset: { x: 0, y: 0 },
    });
  });
});
