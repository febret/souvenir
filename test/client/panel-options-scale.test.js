import { describe, expect, it } from "vitest";
import {
  OPTIONS_SCALE_MAX,
  OPTIONS_SCALE_MIN,
  clampOptionsScale,
} from "../../app/src/scene/panel-options/constants.js";

describe("options window rescale", () => {
  it("keeps values within the shared 2D/3D clamp bounds", () => {
    expect(clampOptionsScale(0.1)).toBe(OPTIONS_SCALE_MIN);
    expect(clampOptionsScale(1)).toBe(1);
    expect(clampOptionsScale(OPTIONS_SCALE_MAX * 3)).toBe(OPTIONS_SCALE_MAX);
  });

  it("resolves invalid input to the neutral scale", () => {
    expect(clampOptionsScale(NaN)).toBe(1);
    expect(clampOptionsScale(undefined)).toBe(1);
    expect(clampOptionsScale(0)).toBe(OPTIONS_SCALE_MIN);
  });

  it("clamps the incremental two-hand multiple", () => {
    const next = clampOptionsScale(1 * 1.5);
    expect(next).toBe(1.5);
    const up = clampOptionsScale(1.5 * 1.6);
    expect(up).toBe(OPTIONS_SCALE_MAX);
    const down = clampOptionsScale(0.65 * 0.8);
    expect(down).toBe(OPTIONS_SCALE_MIN);
  });
});