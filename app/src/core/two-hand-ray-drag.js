const EPSILON = 1e-10;

function finiteVector(value, name) {
  if (!value || typeof value !== "object" || ![value.x, value.y, value.z].every(Number.isFinite)) {
    throw new TypeError(`${name} must be a finite { x, y, z } object.`);
  }
  return { x: value.x, y: value.y, z: value.z };
}

function normalizeVector(value, name) {
  const vector = finiteVector(value, name);
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (length <= EPSILON) throw new RangeError(`${name} must have non-zero length.`);
  return multiply(vector, 1 / length);
}

function normalizedQuaternion(value, name = "Target quaternion") {
  if (!value || typeof value !== "object" || ![value.x, value.y, value.z, value.w].every(Number.isFinite)) {
    throw new TypeError(`${name} must be a finite { x, y, z, w } object.`);
  }
  const length = Math.hypot(value.x, value.y, value.z, value.w);
  if (length <= EPSILON) throw new RangeError(`${name} must have non-zero length.`);
  return { x: value.x / length, y: value.y / length, z: value.z / length, w: value.w / length };
}

function add(left, right) {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(left, right) {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function multiply(value, scalar) {
  return { x: value.x * scalar, y: value.y * scalar, z: value.z * scalar };
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left, right) {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function vectorLength(value) {
  return Math.hypot(value.x, value.y, value.z);
}

function projectPerpendicular(value, axis) {
  return subtract(value, multiply(axis, dot(value, axis)));
}

function rotateVector(value, rotation) {
  const twiceCross = multiply(cross(rotation, value), 2);
  return add(value, add(multiply(twiceCross, rotation.w), cross(rotation, twiceCross)));
}

function multiplyQuaternions(left, right) {
  return normalizedQuaternion({
    x: left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    y: left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    z: left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    w: left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
  }, "Quaternion");
}

function inverseQuaternion(value) {
  return { x: -value.x, y: -value.y, z: -value.z, w: value.w };
}

function quaternionFromFrame({ x, y, z }) {
  const trace = x.x + y.y + z.z;
  let quaternion;
  if (trace > 0) {
    const scale = 2 * Math.sqrt(trace + 1);
    quaternion = { x: (y.z - z.y) / scale, y: (z.x - x.z) / scale, z: (x.y - y.x) / scale, w: scale / 4 };
  } else if (x.x > y.y && x.x > z.z) {
    const scale = 2 * Math.sqrt(1 + x.x - y.y - z.z);
    quaternion = { x: scale / 4, y: (x.y + y.x) / scale, z: (x.z + z.x) / scale, w: (y.z - z.y) / scale };
  } else if (y.y > z.z) {
    const scale = 2 * Math.sqrt(1 + y.y - x.x - z.z);
    quaternion = { x: (x.y + y.x) / scale, y: scale / 4, z: (y.z + z.y) / scale, w: (z.x - x.z) / scale };
  } else {
    const scale = 2 * Math.sqrt(1 + z.z - x.x - y.y);
    quaternion = { x: (x.z + z.x) / scale, y: (y.z + z.y) / scale, z: scale / 4, w: (x.y - y.x) / scale };
  }
  return normalizedQuaternion(quaternion, "Frame quaternion");
}

function deterministicPerpendicular(axis) {
  const candidates = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];
  let candidate = candidates[0];
  for (const next of candidates.slice(1)) {
    if (Math.abs(dot(next, axis)) < Math.abs(dot(candidate, axis))) candidate = next;
  }
  return normalizeVector(projectPerpendicular(candidate, axis), "Frame fallback normal");
}

/**
 * Builds a stable right-handed hand frame. Its x axis joins the hand endpoints
 * and its z axis faces opposite the average ray direction where that is defined.
 */
export function createTwoHandRayFrame(firstEndpoint, secondEndpoint, firstDirection, secondDirection, fallbackNormal) {
  const x = normalizeVector(subtract(secondEndpoint, firstEndpoint), "Hand endpoints");
  const average = add(firstDirection, secondDirection);
  let z = projectPerpendicular(multiply(average, -1), x);
  if (vectorLength(z) <= EPSILON) z = projectPerpendicular(fallbackNormal, x);
  if (vectorLength(z) <= EPSILON) z = deterministicPerpendicular(x);
  else z = normalizeVector(z, "Frame normal");
  const y = normalizeVector(cross(z, x), "Frame y axis");
  z = normalizeVector(cross(x, y), "Frame z axis");
  return { x, y, z, quaternion: quaternionFromFrame({ x, y, z }) };
}

function parseScale(value) {
  const scale = finiteVector(value, "Target scale");
  if ([scale.x, scale.y, scale.z].some((component) => Math.abs(component) <= EPSILON)) {
    throw new RangeError("Target scale components must be non-zero.");
  }
  return scale;
}

function parseScaleLimits(value) {
  const min = value?.min ?? 0.1;
  const max = value?.max ?? 10;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
    throw new RangeError("Scale limits require finite positive min and max values with min <= max.");
  }
  return { min, max };
}

function parseHand(value, name) {
  if (!value || typeof value !== "object") throw new TypeError(`${name} hand is required.`);
  const rayOrigin = finiteVector(value.rayOrigin, `${name} ray origin`);
  const rayDirection = normalizeVector(value.rayDirection, `${name} ray direction`);
  const hitPoint = finiteVector(value.hitPoint, `${name} hit point`);
  const localAnchor = finiteVector(value.localAnchor, `${name} local anchor`);
  const distance = Math.max(0, dot(subtract(hitPoint, rayOrigin), rayDirection));
  return {
    rayOrigin,
    rayDirection,
    hitPoint,
    localAnchor,
    distance,
    endpoint: add(rayOrigin, multiply(rayDirection, distance)),
  };
}

function scaledAnchor(anchor, targetScale, factor) {
  return {
    x: anchor.x * targetScale.x * factor,
    y: anchor.y * targetScale.y * factor,
    z: anchor.z * targetScale.z * factor,
  };
}

function midpoint(first, second) {
  return multiply(add(first, second), 0.5);
}

function assertDistinct(first, second, name) {
  if (vectorLength(subtract(second, first)) <= EPSILON) {
    throw new RangeError(`${name} must be distinct.`);
  }
}

function assertInitialAnchorMapping(hand, targetPosition, targetQuaternion, targetScale, name) {
  const mapped = add(targetPosition, rotateVector(scaledAnchor(hand.localAnchor, targetScale, 1), targetQuaternion));
  const tolerance = 1e-7 * Math.max(1, vectorLength(hand.endpoint), vectorLength(mapped));
  if (vectorLength(subtract(mapped, hand.endpoint)) > tolerance) {
    throw new RangeError(`${name} local anchor must map to its captured ray endpoint.`);
  }
}

/**
 * Captures an absolute, renderer-independent two-hand ray drag relation.
 *
 * When `lockPose` is true the solved pose keeps the captured position and
 * orientation; only the scale factor is applied (locked panels).
 */
export function createTwoHandRayDragState({
  first,
  second,
  targetPosition,
  targetQuaternion,
  targetScale,
  scaleLimits,
  lockPose = false,
} = {}) {
  const initialFirst = parseHand(first, "First");
  const initialSecond = parseHand(second, "Second");
  const position = finiteVector(targetPosition, "Target position");
  const rotation = normalizedQuaternion(targetQuaternion);
  const scale = parseScale(targetScale);
  const limits = parseScaleLimits(scaleLimits);
  assertDistinct(initialFirst.localAnchor, initialSecond.localAnchor, "Local anchors");
  assertDistinct(initialFirst.endpoint, initialSecond.endpoint, "Initial hand endpoints");
  assertInitialAnchorMapping(initialFirst, position, rotation, scale, "First");
  assertInitialAnchorMapping(initialSecond, position, rotation, scale, "Second");

  const targetNormal = rotateVector({ x: 0, y: 0, z: 1 }, rotation);
  const initialFrame = createTwoHandRayFrame(
    initialFirst.endpoint,
    initialSecond.endpoint,
    initialFirst.rayDirection,
    initialSecond.rayDirection,
    targetNormal,
  );

  return {
    first: initialFirst,
    second: initialSecond,
    targetPosition: position,
    targetQuaternion: rotation,
    targetScale: scale,
    scaleLimits: limits,
    lockPose: Boolean(lockPose),
    targetNormal,
    initialSeparation: vectorLength(subtract(initialSecond.endpoint, initialFirst.endpoint)),
    initialFrame,
  };
}

/**
 * Solves an absolute pose from the captured hand relation and current rays.
 */
export function solveTwoHandRayDragPose(state, { first, second } = {}) {
  if (!state || typeof state !== "object") throw new TypeError("Two-hand ray drag state is required.");
  const currentFirstOrigin = finiteVector(first?.rayOrigin, "First ray origin");
  const currentFirstDirection = normalizeVector(first?.rayDirection, "First ray direction");
  const currentSecondOrigin = finiteVector(second?.rayOrigin, "Second ray origin");
  const currentSecondDirection = normalizeVector(second?.rayDirection, "Second ray direction");
  const initialFirst = state.first;
  const initialSecond = state.second;
  if (!initialFirst || !initialSecond || !Number.isFinite(initialFirst.distance) || !Number.isFinite(initialSecond.distance)) {
    throw new TypeError("Two-hand ray drag state is invalid.");
  }

  const firstEndpoint = add(currentFirstOrigin, multiply(currentFirstDirection, initialFirst.distance));
  const secondEndpoint = add(currentSecondOrigin, multiply(currentSecondDirection, initialSecond.distance));
  assertDistinct(firstEndpoint, secondEndpoint, "Current hand endpoints");
  const currentFrame = createTwoHandRayFrame(
    firstEndpoint,
    secondEndpoint,
    currentFirstDirection,
    currentSecondDirection,
    state.initialFrame.z,
  );
  const delta = multiplyQuaternions(currentFrame.quaternion, inverseQuaternion(state.initialFrame.quaternion));
  const quaternion = multiplyQuaternions(delta, normalizedQuaternion(state.targetQuaternion));
  const rawScale = vectorLength(subtract(secondEndpoint, firstEndpoint)) / state.initialSeparation;
  const scaleFactor = Math.min(state.scaleLimits.max, Math.max(state.scaleLimits.min, rawScale));
  const targetScale = scaledAnchor({ x: 1, y: 1, z: 1 }, state.targetScale, scaleFactor);
  const anchorMidpoint = midpoint(initialFirst.localAnchor, initialSecond.localAnchor);
  const midpointValue = midpoint(firstEndpoint, secondEndpoint);
  // Locked panels keep their captured position and orientation; only the
  // scale factor from the pinch spread is applied.
  const position = state.lockPose
    ? { ...state.targetPosition }
    : subtract(
      midpointValue,
      rotateVector(scaledAnchor(anchorMidpoint, state.targetScale, scaleFactor), quaternion),
    );

  return {
    position,
    quaternion: state.lockPose ? { ...state.targetQuaternion } : quaternion,
    targetScale,
    scaleFactor,
    firstEndpoint,
    secondEndpoint,
    midpoint: midpointValue,
  };
}
