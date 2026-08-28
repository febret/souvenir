import {
  PADDING,
  ROW_GAP,
  SECTION_GAP,
  OPTIONS_ROW_HEIGHT,
  SAVE_ROW_HEIGHT,
  DEPTH_LABEL_HEIGHT,
  ADM_SLIDER_HEIGHT,
  ADM_SLIDER_ROW_STEP,
  SWATCH_SIZE,
  TAG_COLUMNS,
} from "./constants.js";

const ADM_SLIDER_COUNT = 5;

/**
 * Pure vertical layout for the options panel. Every section stacks downward
 * from a fixed top edge; tag rows extend the bottom.
 */
export function computeLayout({ tagCount, expandedTags }) {
  const topY = 0.25;
  const optionsY = topY - 0.06 - SECTION_GAP - OPTIONS_ROW_HEIGHT / 2;
  const saveLabelY = optionsY - OPTIONS_ROW_HEIGHT / 2 - SECTION_GAP - 0.01;
  const saveRowY = saveLabelY - 0.03 - SECTION_GAP - SAVE_ROW_HEIGHT / 2;
  const depthLabelY = saveRowY - SAVE_ROW_HEIGHT / 2 - SECTION_GAP - DEPTH_LABEL_HEIGHT / 2;
  const depthSliderY = depthLabelY - DEPTH_LABEL_HEIGHT / 2 - ROW_GAP - ADM_SLIDER_HEIGHT / 2;
  const depthSlidersBottomY = depthSliderY
    - (ADM_SLIDER_COUNT - 1) * ADM_SLIDER_ROW_STEP
    - ADM_SLIDER_HEIGHT / 2;
  const effectButtonY = depthSlidersBottomY - SECTION_GAP - OPTIONS_ROW_HEIGHT / 2;
  const deleteDepthButtonY = effectButtonY - OPTIONS_ROW_HEIGHT - ROW_GAP;
  const lightingLabelY = deleteDepthButtonY - OPTIONS_ROW_HEIGHT / 2 - SECTION_GAP - DEPTH_LABEL_HEIGHT / 2;
  const lightFxY = lightingLabelY - DEPTH_LABEL_HEIGHT / 2 - ROW_GAP - OPTIONS_ROW_HEIGHT / 2;
  const lightDirRow1Y = lightFxY - OPTIONS_ROW_HEIGHT / 2 - ROW_GAP - OPTIONS_ROW_HEIGHT / 2;
  const lightDirRow2Y = lightDirRow1Y - OPTIONS_ROW_HEIGHT - ROW_GAP;
  const lightColorLabelY = lightDirRow2Y - OPTIONS_ROW_HEIGHT / 2 - SECTION_GAP - DEPTH_LABEL_HEIGHT / 2;
  const lightColorRowY = lightColorLabelY - DEPTH_LABEL_HEIGHT / 2 - ROW_GAP - SWATCH_SIZE / 2;
  const ambientColorLabelY = lightColorRowY - SWATCH_SIZE / 2 - SECTION_GAP - DEPTH_LABEL_HEIGHT / 2;
  const ambientColorRowY = ambientColorLabelY - DEPTH_LABEL_HEIGHT / 2 - ROW_GAP - SWATCH_SIZE / 2;
  const ambientIntLabelY = ambientColorRowY - SWATCH_SIZE / 2 - SECTION_GAP - DEPTH_LABEL_HEIGHT / 2;
  const ambientIntY = ambientIntLabelY - DEPTH_LABEL_HEIGHT / 2 - ROW_GAP - OPTIONS_ROW_HEIGHT / 2;
  const tagsStartY = ambientIntY - OPTIONS_ROW_HEIGHT / 2 - SECTION_GAP - 0.01;

  const rows = Math.max(1, Math.ceil(tagCount / TAG_COLUMNS));
  const cellHeight = rows > 3 ? 0.048 : 0.054;

  return {
    topY,
    optionsY,
    saveLabelY,
    saveRowY,
    depthLabelY,
    depthSliderY,
    effectButtonY,
    deleteDepthButtonY,
    lightingLabelY,
    lightFxY,
    lightDirRow1Y,
    lightDirRow2Y,
    lightColorLabelY,
    lightColorRowY,
    ambientColorLabelY,
    ambientColorRowY,
    ambientIntLabelY,
    ambientIntY,
    tagsStartY,
    rows,
    cellHeight,
  };
}

/**
 * Computes final panel bounds from the layout plus rendered tag rows.
 */
export function computeBounds({ topY, tagsStartY, cellHeight, tagsMinY, expandedTags }) {
  let minY = Math.min(tagsStartY - 0.02, tagsMinY);
  minY -= PADDING;
  const maxY = topY + PADDING * 0.6;
  return { height: maxY - minY, centerY: (maxY + minY) / 2 };
}
