/**
 * Panel aspect-ratio modes. `native` uses an image's natural pixel dimensions;
 * the other modes have fixed width-to-height ratios.
 */
export const ASPECT_RATIO_MODES = Object.freeze({
  NATIVE: "native",
  SQUARE: "1:1",
  FOUR_THREE: "4:3",
  THREE_TWO: "3:2",
  SIXTEEN_NINE: "16:9",
  NINE_SIXTEEN: "9:16",
});

export const DEFAULT_ASPECT_RATIO_MODE = ASPECT_RATIO_MODES.NATIVE;

const MODE_CYCLE = Object.freeze([
  ASPECT_RATIO_MODES.NATIVE,
  ASPECT_RATIO_MODES.SQUARE,
  ASPECT_RATIO_MODES.FOUR_THREE,
  ASPECT_RATIO_MODES.THREE_TWO,
  ASPECT_RATIO_MODES.SIXTEEN_NINE,
  ASPECT_RATIO_MODES.NINE_SIXTEEN,
]);

const FIXED_RATIOS = Object.freeze({
  [ASPECT_RATIO_MODES.SQUARE]: 1,
  [ASPECT_RATIO_MODES.FOUR_THREE]: 4 / 3,
  [ASPECT_RATIO_MODES.THREE_TWO]: 3 / 2,
  [ASPECT_RATIO_MODES.SIXTEEN_NINE]: 16 / 9,
  [ASPECT_RATIO_MODES.NINE_SIXTEEN]: 9 / 16,
});

const positive = (value) => Number.isFinite(value) && value > 0;

/**
 * Returns a supported persisted mode, defaulting malformed values to `native`.
 *
 * @param {unknown} mode
 * @returns {"native"|"1:1"|"4:3"|"3:2"|"16:9"|"9:16"}
 */
export function normalizeAspectRatioMode(mode) {
  return MODE_CYCLE.includes(mode) ? mode : DEFAULT_ASPECT_RATIO_MODE;
}

/**
 * Returns the following mode in the panel control's fixed cycle.
 *
 * @param {unknown} mode
 * @returns {"native"|"1:1"|"4:3"|"3:2"|"16:9"|"9:16"}
 */
export function nextAspectRatioMode(mode) {
  const index = MODE_CYCLE.indexOf(normalizeAspectRatioMode(mode));
  return MODE_CYCLE[(index + 1) % MODE_CYCLE.length];
}

/**
 * Resolves a width-to-height ratio.
 *
 * @param {"native"|"1:1"|"4:3"|"3:2"|"16:9"|"9:16"|unknown} mode
 * @param {{sourceWidth?: number, sourceHeight?: number, fallback?: number}} options
 * Natural dimensions are only supplied for loaded images by the scene layer.
 * @returns {number|null} A positive ratio, or null when no usable native/fallback ratio exists.
 */
export function resolveAspectRatio(
  mode,
  { sourceWidth, sourceHeight, fallback } = {},
) {
  const resolvedMode = normalizeAspectRatioMode(mode);
  if (resolvedMode !== ASPECT_RATIO_MODES.NATIVE) {
    return FIXED_RATIOS[resolvedMode];
  }
  if (positive(sourceWidth) && positive(sourceHeight)) {
    return sourceWidth / sourceHeight;
  }
  return positive(fallback) ? fallback : null;
}

/**
 * Calculates dimensions with an unchanged width and aspect-correct, bounded height.
 *
 * @param {{
 *   width: number,
 *   mode?: "native"|"1:1"|"4:3"|"3:2"|"16:9"|"9:16",
 *   sourceWidth?: number,
 *   sourceHeight?: number,
 *   fallback?: number,
 *   minWidth?: number,
 *   maxWidth?: number,
 *   minHeight?: number,
 *   maxHeight?: number
 * }} options
 * @returns {{width: number, height: number}|null} Null means native dimensions are unavailable.
 */
export function dimensionsForAspectRatio({
  width,
  mode = DEFAULT_ASPECT_RATIO_MODE,
  sourceWidth,
  sourceHeight,
  fallback,
  minWidth = 0.2,
  maxWidth = 5,
  minHeight = 0.15,
  maxHeight = 5,
} = {}) {
  if (!positive(width)) return null;
  const ratio = resolveAspectRatio(mode, { sourceWidth, sourceHeight, fallback });
  if (!ratio) return null;
  const lowerBound = positive(minHeight) ? minHeight : 0.15;
  const upperBound = Number.isFinite(maxHeight) && maxHeight >= lowerBound
    ? maxHeight
    : Math.max(5, lowerBound);
  const lowerWidth = positive(minWidth) ? minWidth : 0.2;
  const upperWidth = Number.isFinite(maxWidth) && maxWidth >= lowerWidth
    ? maxWidth
    : Math.max(5, lowerWidth);
  let resolvedWidth = Math.min(upperWidth, Math.max(lowerWidth, width));
  let resolvedHeight = resolvedWidth / ratio;
  if (resolvedHeight < lowerBound) {
    resolvedHeight = lowerBound;
    resolvedWidth = Math.min(upperWidth, resolvedHeight * ratio);
  } else if (resolvedHeight > upperBound) {
    resolvedHeight = upperBound;
    resolvedWidth = Math.max(lowerWidth, resolvedHeight * ratio);
  }
  return { width: resolvedWidth, height: resolvedHeight };
}
