import { describe, expect, it } from "vitest";

import {
  OPTIONS_WINDOW_MARGIN,
  optionsWindowPosition,
} from "../../app/src/core/options-window.js";

const host = { width: 1000, height: 800 };
const size = { width: 320, height: 260 };

describe("desktop options window placement", () => {
  it("draws the window at its offset from the panel anchor", () => {
    expect(optionsWindowPosition({
      anchor: { x: 500, y: 400 },
      offset: { x: 130, y: -40 },
      host,
      size,
    })).toEqual({ x: 630, y: 360 });
  });

  it("follows the panel when its anchor moves", () => {
    const offset = { x: 130, y: -40 };
    const first = optionsWindowPosition({ anchor: { x: 400, y: 400 }, offset, host, size });
    const second = optionsWindowPosition({ anchor: { x: 460, y: 380 }, offset, host, size });
    expect(second.x - first.x).toBe(60);
    expect(second.y - first.y).toBe(-20);
  });

  it("keeps the window inside the host on every side", () => {
    expect(optionsWindowPosition({
      anchor: { x: 10, y: 10 },
      offset: { x: -400, y: -400 },
      host,
      size,
    })).toEqual({ x: OPTIONS_WINDOW_MARGIN, y: OPTIONS_WINDOW_MARGIN });
    expect(optionsWindowPosition({
      anchor: { x: 990, y: 790 },
      offset: { x: 400, y: 400 },
      host,
      size,
    })).toEqual({ x: 1000 - 320 - 8, y: 800 - 260 - 8 });
  });

  it("prefers the leading margin when the window does not fit the host", () => {
    expect(optionsWindowPosition({
      anchor: { x: 0, y: 0 },
      offset: { x: 0, y: 0 },
      host: { width: 200, height: 100 },
      size,
    })).toEqual({ x: OPTIONS_WINDOW_MARGIN, y: OPTIONS_WINDOW_MARGIN });
  });

  it("falls back to the anchor for unusable inputs", () => {
    expect(optionsWindowPosition({
      anchor: { x: Number.NaN, y: undefined },
      offset: { x: 10, y: 20 },
      host,
      size,
    })).toEqual({ x: 10, y: 20 });
    expect(optionsWindowPosition()).toEqual({ x: 8, y: 8 });
  });
});
