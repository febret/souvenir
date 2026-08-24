import { describe, expect, it } from "vitest";
import {
  ASPECT_RATIO_MODES,
  DEFAULT_ASPECT_RATIO_MODE,
  dimensionsForAspectRatio,
  nextAspectRatioMode,
  normalizeAspectRatioMode,
  resolveAspectRatio,
} from "../../app/src/core/aspect-ratio.js";

describe("panel aspect ratios", () => {
  it("uses Native by default and cycles every supported mode in order", () => {
    expect(DEFAULT_ASPECT_RATIO_MODE).toBe(ASPECT_RATIO_MODES.NATIVE);
    expect(ASPECT_RATIO_MODES).toEqual({
      NATIVE: "native",
      SQUARE: "1:1",
      FOUR_THREE: "4:3",
      THREE_TWO: "3:2",
      SIXTEEN_NINE: "16:9",
      NINE_SIXTEEN: "9:16",
    });

    const cycle = [
      ASPECT_RATIO_MODES.NATIVE,
      ASPECT_RATIO_MODES.SQUARE,
      ASPECT_RATIO_MODES.FOUR_THREE,
      ASPECT_RATIO_MODES.THREE_TWO,
      ASPECT_RATIO_MODES.SIXTEEN_NINE,
      ASPECT_RATIO_MODES.NINE_SIXTEEN,
      ASPECT_RATIO_MODES.NATIVE,
    ];
    expect(cycle.slice(1)).toEqual(cycle.slice(0, -1).map(nextAspectRatioMode));
  });

  it("normalizes malformed persisted modes to Native", () => {
    for (const value of [undefined, null, "", "square", "16/9", 16 / 9]) {
      expect(normalizeAspectRatioMode(value)).toBe(ASPECT_RATIO_MODES.NATIVE);
    }
  });

  it("resolves native landscape and portrait sources plus fixed modes", () => {
    expect(resolveAspectRatio(ASPECT_RATIO_MODES.NATIVE, {
      sourceWidth: 1600,
      sourceHeight: 900,
    })).toBeCloseTo(16 / 9);
    expect(resolveAspectRatio(ASPECT_RATIO_MODES.NATIVE, {
      sourceWidth: 1200,
      sourceHeight: 1600,
    })).toBeCloseTo(3 / 4);
    expect(resolveAspectRatio(ASPECT_RATIO_MODES.SQUARE)).toBe(1);
    expect(resolveAspectRatio(ASPECT_RATIO_MODES.FOUR_THREE)).toBeCloseTo(4 / 3);
    expect(resolveAspectRatio(ASPECT_RATIO_MODES.THREE_TWO)).toBeCloseTo(3 / 2);
    expect(resolveAspectRatio(ASPECT_RATIO_MODES.SIXTEEN_NINE)).toBeCloseTo(16 / 9);
    expect(resolveAspectRatio(ASPECT_RATIO_MODES.NINE_SIXTEEN)).toBeCloseTo(9 / 16);
  });

  it("preserves width when possible and preserves the ratio at dimension bounds", () => {
    expect(dimensionsForAspectRatio({
      width: 1.2,
      mode: ASPECT_RATIO_MODES.FOUR_THREE,
    })).toEqual({ width: 1.2, height: 0.9 });
    const minimumBound = dimensionsForAspectRatio({
      width: 1,
      mode: ASPECT_RATIO_MODES.SIXTEEN_NINE,
      minHeight: 0.7,
    });
    expect(minimumBound.height).toBe(0.7);
    expect(minimumBound.width / minimumBound.height).toBeCloseTo(16 / 9);
    const maximumBound = dimensionsForAspectRatio({
      width: 1,
      mode: ASPECT_RATIO_MODES.NINE_SIXTEEN,
      maxHeight: 0.9,
    });
    expect(maximumBound.height).toBe(0.9);
    expect(maximumBound.width / maximumBound.height).toBeCloseTo(9 / 16);
  });

  it("uses the current aspect fallback for unusable Native sources", () => {
    expect(resolveAspectRatio(ASPECT_RATIO_MODES.NATIVE, {
      sourceWidth: 0,
      sourceHeight: Number.NaN,
      fallback: 3 / 2,
    })).toBeCloseTo(3 / 2);
    expect(dimensionsForAspectRatio({
      width: 1.2,
      mode: ASPECT_RATIO_MODES.NATIVE,
      sourceWidth: -1,
      sourceHeight: Infinity,
      fallback: 3 / 2,
    })).toMatchObject({ width: 1.2 });
    expect(dimensionsForAspectRatio({
      width: 1.2,
      mode: ASPECT_RATIO_MODES.NATIVE,
      sourceWidth: -1,
      sourceHeight: Infinity,
      fallback: 3 / 2,
    }).height).toBeCloseTo(0.8);
    expect(dimensionsForAspectRatio({
      width: 1.2,
      mode: ASPECT_RATIO_MODES.NATIVE,
      sourceWidth: 0,
      sourceHeight: 0,
    })).toBeNull();
  });
});
