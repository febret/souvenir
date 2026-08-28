// Shared geometry and palette constants for the panel options chrome.
// Values must mirror LIGHT_COLOR_HEX in panel-view.js.
export const SAVE_MODE_DEFINITIONS = [
  ["Disabled", "disabled"],
  ["Scale", "scale"],
  ["Full", "full"],
];
export const PANEL_WIDTH = 0.84;
export const PADDING = 0.015;
export const TITLE_HEIGHT = 0.06;
export const SECTION_GAP = 0.012;
export const ROW_GAP = 0.006;
export const OPTIONS_ROW_HEIGHT = 0.052;
export const SAVE_ROW_HEIGHT = 0.05;
export const DEPTH_LABEL_HEIGHT = 0.04;
export const ADM_SLIDER_HEIGHT = 0.052;
export const ADM_SLIDER_ROW_GAP = 0.012;
export const ADM_SLIDER_ROW_STEP = ADM_SLIDER_HEIGHT + ADM_SLIDER_ROW_GAP;
export const TAG_COLUMNS = 3;
export const SWATCH_SIZE = 0.07;

export const COLOR_SWATCHES = [
  ["white", "#ffffff"],
  ["warm", "#ffd6a0"],
  ["cool", "#b0d4ff"],
  ["rose", "#ffb0c8"],
  ["mint", "#a8f0d8"],
  ["gold", "#ffe080"],
];

export const LIGHT_DIRECTIONS = [
  ["Top", "top"],
  ["Top-Left", "top-left"],
  ["Top-Right", "top-right"],
  ["Front", "front"],
  ["Left", "left"],
  ["Right", "right"],
];

export const AMBIENT_INTENSITY_STEPS = [
  ["0%", 0],
  ["25%", 0.25],
  ["50%", 0.5],
  ["75%", 0.75],
  ["100%", 1],
];

export const OPTIONS_ROW = [
  ["Mask", "toggle-mask"],
  ["Edit BG", "edit-erase-mask"],
  ["3D Mode", "toggle-3d-mode"],
];

export const DEPTH_EFFECT_BUTTONS = [
  ["Soft depth", "toggle-soft-depth"],
  ["Fade depth", "toggle-fade-depth"],
  ["Focus blur", "toggle-focus-blur"],
];
