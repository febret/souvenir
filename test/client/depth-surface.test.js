import { describe, expect, it } from "vitest";

import { resolveFadeDepthRange } from "../../app/src/scene/depth-surface.js";

describe("resolveFadeDepthRange", () => {
  it("maps 0% fade start to minimum sampled depth", () => {
    const { startDepth, endDepth } = resolveFadeDepthRange(0, 0.2, 0.8);
    expect(startDepth).toBeCloseTo(0.2);
    expect(endDepth).toBeCloseTo(0.8);
  });

  it("maps 100% fade start to maximum sampled depth", () => {
    const { startDepth, endDepth } = resolveFadeDepthRange(1, 0.2, 0.8);
    expect(startDepth).toBeCloseTo(0.8);
    expect(endDepth).toBeCloseTo(0.8);
  });

  it("always uses the sampled max depth as the fade end", () => {
    const { startDepth, endDepth } = resolveFadeDepthRange(0.35, 0.1, 0.6);
    expect(startDepth).toBeCloseTo(0.275);
    expect(endDepth).toBeCloseTo(0.6);
  });
});
