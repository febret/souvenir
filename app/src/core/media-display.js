/**
 * Pure image-display layout helpers. Values returned here are renderer agnostic:
 * surface dimensions are world metres and UV values are normalized texture
 * coordinates. Actual-size rendering uses 1,000 source pixels per world metre.
 */
export const DISPLAY_MODES = Object.freeze({
  ACTUAL: "actual",
  FILL: "fill",
  FIT: "fit",
});

export const DEFAULT_DISPLAY_MODE = DISPLAY_MODES.FIT;
export const ACTUAL_PIXELS_PER_WORLD_METER = 1000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const positive = (value, fallback = 1) =>
  Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * Returns a supported display mode, falling back to the persisted-state default.
 */
export function normalizeDisplayMode(mode) {
  return Object.values(DISPLAY_MODES).includes(mode) ? mode : DEFAULT_DISPLAY_MODE;
}

/**
 * Returns the next display mode in the image double-tap cycle.
 */
export function nextDisplayMode(mode) {
  switch (normalizeDisplayMode(mode)) {
    case DISPLAY_MODES.ACTUAL:
      return DISPLAY_MODES.FILL;
    case DISPLAY_MODES.FILL:
      return DISPLAY_MODES.FIT;
    default:
      return DISPLAY_MODES.ACTUAL;
  }
}

/**
 * Calculates an aspect-correct contained surface for fit mode.
 */
export function fitMediaSize({ panelWidth, panelHeight, sourceWidth, sourceHeight } = {}) {
  const width = positive(panelWidth);
  const height = positive(panelHeight);
  const aspect = positive(sourceWidth) / positive(sourceHeight);
  return width / height > aspect
    ? { width: height * aspect, height }
    : { width, height: width / aspect };
}

/**
 * Calculates the centered UV crop that lets an image cover a panel in fill mode.
 */
export function fillMediaUv({ panelWidth, panelHeight, sourceWidth, sourceHeight } = {}) {
  const panelAspect = positive(panelWidth) / positive(panelHeight);
  const sourceAspect = positive(sourceWidth) / positive(sourceHeight);
  const repeat = panelAspect > sourceAspect
    ? { x: 1, y: sourceAspect / panelAspect }
    : { x: panelAspect / sourceAspect, y: 1 };
  return {
    repeat,
    offset: { x: (1 - repeat.x) / 2, y: (1 - repeat.y) / 2 },
  };
}

/**
 * Calculates the visible native-size area. Large images crop at the panel
 * boundary; small images retain their native physical size and remain centered.
 */
export function actualMediaLayout({
  panelWidth,
  panelHeight,
  sourceWidth,
  sourceHeight,
  pixelsPerWorldMeter = ACTUAL_PIXELS_PER_WORLD_METER,
} = {}) {
  const width = positive(panelWidth);
  const height = positive(panelHeight);
  const nativeWidth = positive(sourceWidth) / positive(pixelsPerWorldMeter);
  const nativeHeight = positive(sourceHeight) / positive(pixelsPerWorldMeter);
  const surface = {
    width: Math.min(width, nativeWidth),
    height: Math.min(height, nativeHeight),
  };
  const repeat = {
    x: Math.min(1, width / nativeWidth),
    y: Math.min(1, height / nativeHeight),
  };
  return {
    surface,
    uv: {
      repeat,
      offset: { x: (1 - repeat.x) / 2, y: (1 - repeat.y) / 2 },
    },
  };
}

function panUv(uv, pan) {
  const repeat = uv.repeat;
  return {
    repeat,
    offset: {
      x: clamp(uv.offset.x - (Number.isFinite(pan?.x) ? pan.x : 0), 0, 1 - repeat.x),
      y: clamp(uv.offset.y + (Number.isFinite(pan?.y) ? pan.y : 0), 0, 1 - repeat.y),
    },
  };
}

/**
 * Calculates a complete display layout for fit, fill, or actual modes.
 *
 * `contentZoom` and `contentPan` are layered over the base mode. Zooming in
 * narrows UVs; zooming out shrinks the surface instead, so clamped textures
 * never tile or stretch outside their image bounds.
 */
export function mediaDisplayLayout({
  mode = DEFAULT_DISPLAY_MODE,
  panelWidth,
  panelHeight,
  sourceWidth,
  sourceHeight,
  contentZoom = 1,
  contentPan = { x: 0, y: 0 },
  pixelsPerWorldMeter = ACTUAL_PIXELS_PER_WORLD_METER,
} = {}) {
  const resolvedMode = normalizeDisplayMode(mode);
  const panel = {
    width: positive(panelWidth),
    height: positive(panelHeight),
  };
  const source = {
    width: positive(sourceWidth),
    height: positive(sourceHeight),
  };
  const zoom = positive(contentZoom);
  const zoomOut = Math.min(zoom, 1);
  let surface;
  let uv;

  if (resolvedMode === DISPLAY_MODES.FILL) {
    surface = { width: panel.width * zoomOut, height: panel.height * zoomOut };
    uv = fillMediaUv({
      panelWidth: panel.width,
      panelHeight: panel.height,
      sourceWidth: source.width,
      sourceHeight: source.height,
    });
  } else if (resolvedMode === DISPLAY_MODES.ACTUAL) {
    ({ surface, uv } = actualMediaLayout({
      panelWidth: panel.width,
      panelHeight: panel.height,
      sourceWidth: source.width,
      sourceHeight: source.height,
      pixelsPerWorldMeter: positive(pixelsPerWorldMeter, ACTUAL_PIXELS_PER_WORLD_METER) / zoomOut,
    }));
  } else {
    const fitted = fitMediaSize({
      panelWidth: panel.width,
      panelHeight: panel.height,
      sourceWidth: source.width,
      sourceHeight: source.height,
    });
    surface = { width: fitted.width * zoomOut, height: fitted.height * zoomOut };
    uv = { repeat: { x: 1, y: 1 }, offset: { x: 0, y: 0 } };
  }

  if (zoom > 1) {
    uv = {
      repeat: { x: uv.repeat.x / zoom, y: uv.repeat.y / zoom },
      offset: {
        x: (1 - uv.repeat.x / zoom) / 2,
        y: (1 - uv.repeat.y / zoom) / 2,
      },
    };
  }

  uv = panUv(uv, contentPan);

  const horizontalSpace = Math.max(0, (panel.width - surface.width) / 2);
  const verticalSpace = Math.max(0, (panel.height - surface.height) / 2);
  return {
    mode: resolvedMode,
    surface,
    position: {
      x: clamp(-(Number.isFinite(contentPan?.x) ? contentPan.x : 0) * panel.width, -horizontalSpace, horizontalSpace),
      y: clamp((Number.isFinite(contentPan?.y) ? contentPan.y : 0) * panel.height, -verticalSpace, verticalSpace),
    },
    uv,
  };
}

/**
 * Backwards-compatible concise name for {@link mediaDisplayLayout}.
 */
export function mediaDisplayTransform(options = {}) {
  return mediaDisplayLayout(options);
}
