import { describe, expect, it } from "vitest";

import {
  ADM_SLIDER_HEIGHT,
  ADM_SLIDER_ROW_STEP,
  DEPTH_LABEL_HEIGHT,
  OPTIONS_ROW_HEIGHT,
  ROW_GAP,
  SECTION_GAP,
} from "../../app/src/scene/panel-options/constants.js";
import { computeBounds, computeLayout } from "../../app/src/scene/panel-options/layout.js";

const ADM_SLIDER_COUNT = 5;

function bottomOf(centerY, height) {
  return centerY - height / 2;
}

function topOf(centerY, height) {
  return centerY + height / 2;
}

describe("panel options layout", () => {
  it("reserves vertical space for the ADM slider stack", () => {
    const layout = computeLayout({ tagCount: 9, expandedTags: true });
    const sliderStackTop = topOf(layout.depthSliderY, ADM_SLIDER_HEIGHT);
    const sliderStackBottom = bottomOf(
      layout.depthSliderY - (ADM_SLIDER_COUNT - 1) * ADM_SLIDER_ROW_STEP,
      ADM_SLIDER_HEIGHT,
    );

    expect(bottomOf(layout.depthLabelY, DEPTH_LABEL_HEIGHT) - sliderStackTop)
      .toBeCloseTo(ROW_GAP);
    expect(sliderStackBottom - topOf(layout.effectButtonY, OPTIONS_ROW_HEIGHT))
      .toBeCloseTo(SECTION_GAP);
    expect(bottomOf(layout.effectButtonY, OPTIONS_ROW_HEIGHT) - topOf(layout.deleteDepthButtonY, OPTIONS_ROW_HEIGHT))
      .toBeCloseTo(ROW_GAP);
    expect(bottomOf(layout.deleteDepthButtonY, OPTIONS_ROW_HEIGHT) - topOf(layout.lightingLabelY, DEPTH_LABEL_HEIGHT))
      .toBeCloseTo(SECTION_GAP);

    const bounds = computeBounds({
      topY: layout.topY,
      tagsStartY: layout.tagsStartY,
      cellHeight: layout.cellHeight,
      tagsMinY: layout.tagsStartY - 0.2,
      expandedTags: true,
    });
    expect(bounds.height).toBeGreaterThan(layout.topY - sliderStackBottom);
  });
});