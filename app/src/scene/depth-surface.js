import * as THREE from "three";

const MAX_GRID_SEGMENTS = 256;

/**
 * Builds the displaced image plane used by panel depth mode. Keeping this CPU
 * conversion outside PanelView makes the expensive rebuild boundary explicit.
 */
export function createDisplacedPlaneGeometry(
  depthCanvas,
  intensity = 0.35,
  segments,
) {
  const safeIntensity = Math.max(0, Math.min(3, Number(intensity) || 0));
  const width = Math.max(1, depthCanvas?.width ?? 0);
  const height = Math.max(1, depthCanvas?.height ?? 0);
  const gridSegments = Number.isFinite(segments)
    ? Math.max(1, Math.min(MAX_GRID_SEGMENTS, Math.trunc(segments)))
    : Math.min(MAX_GRID_SEGMENTS, Math.min(width, height));
  const probe = document.createElement("canvas");
  probe.width = width;
  probe.height = height;
  const context = probe.getContext("2d", { willReadFrequently: true });
  context.drawImage(depthCanvas, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  let maximumSampleDepth = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const depth = (pixels[offset] ?? 0) / 255;
    if (depth > maximumSampleDepth) maximumSampleDepth = depth;
  }
  const geometry = new THREE.PlaneGeometry(1, 1, gridSegments, gridSegments);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const u = positions.getX(index) + 0.5;
    const v = positions.getY(index) + 0.5;
    const pixelX = Math.max(0, Math.min(width - 1, Math.round(u * (width - 1))));
    const pixelY = Math.max(0, Math.min(height - 1, Math.round((1 - v) * (height - 1))));
    const offset = (pixelY * width + pixelX) * 4;
    const depth = (pixels[offset] ?? 0) / 255;
    positions.setZ(index, depth * safeIntensity * 0.18);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return {
    geometry,
    maximumDepth: maximumSampleDepth * safeIntensity * 0.18,
  };
}
