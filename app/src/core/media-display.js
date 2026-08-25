/**
 * Pure media-display layout helpers. Values returned here are renderer
 * agnostic: surface dimensions are world metres and UV values are normalized
 * texture coordinates. Media always renders at its native pixel density using
 * 1,000 source pixels per world metre.
 */
export const ACTUAL_PIXELS_PER_WORLD_METER = 1000;

const positive = (value, fallback = 1) =>
  Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * Calculates the native-size surface dimensions for a media item.
 *
 * The surface keeps the media's native aspect ratio at a constant pixel
 * density, multiplied by an optional user scale.
 */
export function nativeMediaSize({
  sourceWidth,
  sourceHeight,
  scale = 1,
  pixelsPerWorldMeter = ACTUAL_PIXELS_PER_WORLD_METER,
} = {}) {
  const density = positive(pixelsPerWorldMeter, ACTUAL_PIXELS_PER_WORLD_METER);
  const resolvedScale = positive(scale);
  return {
    width: positive(sourceWidth) / density * resolvedScale,
    height: positive(sourceHeight) / density * resolvedScale,
  };
}

/**
 * Resolves the largest uniform media scale that fits within a panel.
 */
export function mediaScaleForPanel({
  sourceWidth,
  sourceHeight,
  panelWidth,
  panelHeight,
  pixelsPerWorldMeter = ACTUAL_PIXELS_PER_WORLD_METER,
} = {}) {
  const native = nativeMediaSize({
    sourceWidth,
    sourceHeight,
    pixelsPerWorldMeter,
  });
  const widthScale = positive(panelWidth, native.width) / native.width;
  const heightScale = positive(panelHeight, native.height) / native.height;
  return Math.min(widthScale, heightScale);
}

/**
 * Calculates the complete display layout for media shown full scale.
 *
 * The surface is centered in the panel with identity UVs; panel dimensions are
 * expected to already match the media's native aspect ratio times any saved
 * scale.
 */
export function mediaDisplayLayout({
  sourceWidth,
  sourceHeight,
  scale = 1,
  panelWidth,
  panelHeight,
  pixelsPerWorldMeter = ACTUAL_PIXELS_PER_WORLD_METER,
} = {}) {
  const resolvedScale = Number.isFinite(panelWidth) && panelWidth > 0
    && Number.isFinite(panelHeight) && panelHeight > 0
    ? mediaScaleForPanel({
      sourceWidth,
      sourceHeight,
      panelWidth,
      panelHeight,
      pixelsPerWorldMeter,
    })
    : scale;
  return {
    surface: nativeMediaSize({
      sourceWidth,
      sourceHeight,
      scale: resolvedScale,
      pixelsPerWorldMeter,
    }),
    position: { x: 0, y: 0 },
    uv: { repeat: { x: 1, y: 1 }, offset: { x: 0, y: 0 } },
  };
}
