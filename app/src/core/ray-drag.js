const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

const vector = (value, fallback = { x: 0, y: 0, z: 0 }) => ({
  x: finite(value?.x, finite(fallback?.x)),
  y: finite(value?.y, finite(fallback?.y)),
  z: finite(value?.z, finite(fallback?.z)),
});

const scale = (value) => ({
  x: nonZero(value?.x),
  y: nonZero(value?.y),
  z: nonZero(value?.z),
});

function nonZero(value) {
  const result = finite(value, 1);
  return Math.abs(result) > Number.EPSILON ? result : 1;
}

function normalizeRayDirection(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("A finite ray direction is required.");
  }
  if (![value.x, value.y, value.z].every(Number.isFinite)) {
    throw new TypeError("Ray direction components must be finite.");
  }
  const length = Math.hypot(value.x, value.y, value.z);
  if (length <= Number.EPSILON) {
    throw new RangeError("Ray direction must have non-zero length.");
  }
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function quaternion(value, fallback = { x: 0, y: 0, z: 0, w: 1 }) {
  const fallbackQuaternion = {
    x: finite(fallback?.x),
    y: finite(fallback?.y),
    z: finite(fallback?.z),
    w: finite(fallback?.w, 1),
  };
  const fallbackLength = Math.hypot(
    fallbackQuaternion.x,
    fallbackQuaternion.y,
    fallbackQuaternion.z,
    fallbackQuaternion.w,
  );
  const result = {
    x: finite(value?.x, fallbackQuaternion.x),
    y: finite(value?.y, fallbackQuaternion.y),
    z: finite(value?.z, fallbackQuaternion.z),
    w: finite(value?.w, fallbackQuaternion.w),
  };
  const length = Math.hypot(result.x, result.y, result.z, result.w);
  if (length <= Number.EPSILON) {
    if (fallbackLength <= Number.EPSILON) return { x: 0, y: 0, z: 0, w: 1 };
    return {
      x: fallbackQuaternion.x / fallbackLength,
      y: fallbackQuaternion.y / fallbackLength,
      z: fallbackQuaternion.z / fallbackLength,
      w: fallbackQuaternion.w / fallbackLength,
    };
  }
  return {
    x: result.x / length,
    y: result.y / length,
    z: result.z / length,
    w: result.w / length,
  };
}

function multiplyQuaternions(left, right) {
  return quaternion({
    x: left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    y: left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    z: left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    w: left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
  });
}

function inverseQuaternion(value) {
  const normalized = quaternion(value);
  return { x: -normalized.x, y: -normalized.y, z: -normalized.z, w: normalized.w };
}

function rotateVector(value, rotation) {
  const q = quaternion(rotation);
  const v = vector(value);
  const twiceCross = {
    x: 2 * (q.y * v.z - q.z * v.y),
    y: 2 * (q.z * v.x - q.x * v.z),
    z: 2 * (q.x * v.y - q.y * v.x),
  };
  return {
    x: v.x + q.w * twiceCross.x + q.y * twiceCross.z - q.z * twiceCross.y,
    y: v.y + q.w * twiceCross.y + q.z * twiceCross.x - q.x * twiceCross.z,
    z: v.z + q.w * twiceCross.z + q.x * twiceCross.y - q.y * twiceCross.x,
  };
}

function localAnchorFromWorld(hitPoint, targetPosition, targetQuaternion, targetScale) {
  const relative = {
    x: hitPoint.x - targetPosition.x,
    y: hitPoint.y - targetPosition.y,
    z: hitPoint.z - targetPosition.z,
  };
  const unrotated = rotateVector(relative, inverseQuaternion(targetQuaternion));
  return {
    x: unrotated.x / targetScale.x,
    y: unrotated.y / targetScale.y,
    z: unrotated.z / targetScale.z,
  };
}

/**
 * Captures the immutable world-space relation needed to keep a panel's selected
 * point on a controller ray. All returned values are plain serializable objects.
 */
export function createRayDragState({
  rayOrigin,
  rayDirection,
  hitPoint,
  targetPosition,
  targetQuaternion,
  targetScale,
  localAnchor,
  controllerQuaternion,
} = {}) {
  const origin = vector(rayOrigin);
  const direction = normalizeRayDirection(rayDirection);
  const position = vector(targetPosition);
  const rotation = quaternion(targetQuaternion);
  const panelScale = scale(targetScale);
  const point = vector(hitPoint, position);
  const controllerRotation = quaternion(controllerQuaternion);
  const offset = {
    x: point.x - origin.x,
    y: point.y - origin.y,
    z: point.z - origin.z,
  };
  const distance = Math.max(0, offset.x * direction.x + offset.y * direction.y + offset.z * direction.z);

  return {
    rayOrigin: origin,
    rayDirection: direction,
    hitPoint: point,
    targetPosition: position,
    targetQuaternion: rotation,
    targetScale: panelScale,
    localAnchor: localAnchor
      ? vector(localAnchor)
      : localAnchorFromWorld(point, position, rotation, panelScale),
    distance,
    controllerQuaternion: controllerRotation,
    orientationOffset: multiplyQuaternions(inverseQuaternion(controllerRotation), rotation),
  };
}

/**
 * Solves an absolute panel world pose without accumulating frame-to-frame deltas.
 */
export function solveRayDragPose(state, { rayOrigin, rayDirection, controllerQuaternion } = {}) {
  const captured = state ?? {};
  const origin = vector(rayOrigin, captured.rayOrigin);
  const direction = normalizeRayDirection(
    rayDirection === undefined ? captured.rayDirection : rayDirection,
  );
  const controllerRotation = quaternion(controllerQuaternion, captured.controllerQuaternion);
  const orientationOffset = quaternion(captured.orientationOffset);
  const panelQuaternion = multiplyQuaternions(controllerRotation, orientationOffset);
  const endpoint = {
    x: origin.x + direction.x * Math.max(0, finite(captured.distance)),
    y: origin.y + direction.y * Math.max(0, finite(captured.distance)),
    z: origin.z + direction.z * Math.max(0, finite(captured.distance)),
  };
  const anchor = vector(captured.localAnchor);
  const panelScale = scale(captured.targetScale);
  const anchorOffset = rotateVector({
    x: anchor.x * panelScale.x,
    y: anchor.y * panelScale.y,
    z: anchor.z * panelScale.z,
  }, panelQuaternion);

  return {
    position: {
      x: endpoint.x - anchorOffset.x,
      y: endpoint.y - anchorOffset.y,
      z: endpoint.z - anchorOffset.z,
    },
    quaternion: panelQuaternion,
    rayEndpoint: endpoint,
  };
}
