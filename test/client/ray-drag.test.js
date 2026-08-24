import { describe, expect, it } from "vitest";
import { createRayDragState, solveRayDragPose } from "../../app/src/core/ray-drag.js";

const identity = { x: 0, y: 0, z: 0, w: 1 };

function multiplyQuaternions(left, right) {
  return {
    x: left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    y: left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    z: left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    w: left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
  };
}

function inverseQuaternion(value) {
  return { x: -value.x, y: -value.y, z: -value.z, w: value.w };
}

function rotateVector(value, quaternion) {
  const twiceCross = {
    x: 2 * (quaternion.y * value.z - quaternion.z * value.y),
    y: 2 * (quaternion.z * value.x - quaternion.x * value.z),
    z: 2 * (quaternion.x * value.y - quaternion.y * value.x),
  };
  return {
    x: value.x + quaternion.w * twiceCross.x + quaternion.y * twiceCross.z - quaternion.z * twiceCross.y,
    y: value.y + quaternion.w * twiceCross.y + quaternion.z * twiceCross.x - quaternion.x * twiceCross.z,
    z: value.z + quaternion.w * twiceCross.z + quaternion.x * twiceCross.y - quaternion.y * twiceCross.x,
  };
}

function expectVectorClose(actual, expected) {
  expect(actual.x).toBeCloseTo(expected.x, 12);
  expect(actual.y).toBeCloseTo(expected.y, 12);
  expect(actual.z).toBeCloseTo(expected.z, 12);
}

function expectQuaternionClose(actual, expected) {
  expect(actual.x).toBeCloseTo(expected.x, 12);
  expect(actual.y).toBeCloseTo(expected.y, 12);
  expect(actual.z).toBeCloseTo(expected.z, 12);
  expect(actual.w).toBeCloseTo(expected.w, 12);
}

function anchorWorldPoint(pose, anchor, scale) {
  const scaledAnchor = rotateVector({
    x: anchor.x * scale.x,
    y: anchor.y * scale.y,
    z: anchor.z * scale.z,
  }, pose.quaternion);
  return {
    x: pose.position.x + scaledAnchor.x,
    y: pose.position.y + scaledAnchor.y,
    z: pose.position.z + scaledAnchor.z,
  };
}

describe("anchored ray dragging", () => {
  it("returns the exact initial pose for a centered initial grab", () => {
    const targetPosition = { x: 0, y: 0, z: -3 };
    const targetQuaternion = { x: 0, y: 1, z: 0, w: 0 };
    const state = createRayDragState({
      rayOrigin: { x: 0, y: 0, z: 0 },
      rayDirection: { x: 0, y: 0, z: -1 },
      hitPoint: targetPosition,
      targetPosition,
      targetQuaternion,
      targetScale: { x: 1, y: 1, z: 1 },
      controllerQuaternion: identity,
    });

    const pose = solveRayDragPose(state, {
      rayOrigin: { x: 0, y: 0, z: 0 },
      rayDirection: { x: 0, y: 0, z: -1 },
      controllerQuaternion: identity,
    });

    expect(pose.position).toEqual(targetPosition);
    expect(pose.quaternion).toEqual(targetQuaternion);
  });

  it("keeps an off-center local hit anchor on the ray endpoint with nonuniform target scale", () => {
    const targetPosition = { x: 0, y: 0, z: -3 };
    const targetScale = { x: 2, y: 3, z: 4 };
    const localAnchor = { x: 0.5, y: -1, z: 0.25 };
    const targetQuaternion = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
    const hitPoint = { x: 3, y: 1, z: -2 };
    const state = createRayDragState({
      rayOrigin: { x: 3, y: 1, z: 10 },
      rayDirection: { x: 0, y: 0, z: -2 },
      hitPoint,
      targetPosition,
      targetQuaternion,
      targetScale,
      controllerQuaternion: targetQuaternion,
    });

    const pose = solveRayDragPose(state, {
      rayOrigin: { x: 3, y: 1, z: 10 },
      rayDirection: { x: 0, y: 0, z: -1 },
      controllerQuaternion: targetQuaternion,
    });

    expectVectorClose(state.localAnchor, localAnchor);
    expect(pose.rayEndpoint).toEqual(hitPoint);
    expectVectorClose(anchorWorldPoint(pose, localAnchor, targetScale), pose.rayEndpoint);
  });

  it("translates the target equally when the ray origin translates", () => {
    const state = createRayDragState({
      rayOrigin: { x: 1, y: 2, z: 3 },
      rayDirection: { x: 0, y: 0, z: -1 },
      hitPoint: { x: 1, y: 2, z: -2 },
      targetPosition: { x: 1, y: 2, z: -2 },
      targetQuaternion: identity,
      controllerQuaternion: identity,
    });
    const start = solveRayDragPose(state, {
      rayOrigin: { x: 1, y: 2, z: 3 },
      rayDirection: { x: 0, y: 0, z: -1 },
      controllerQuaternion: identity,
    });
    const moved = solveRayDragPose(state, {
      rayOrigin: { x: -3, y: 7, z: 5 },
      rayDirection: { x: 0, y: 0, z: -1 },
      controllerQuaternion: identity,
    });

    expectVectorClose(moved.position, { x: start.position.x - 4, y: start.position.y + 5, z: start.position.z + 2 });
  });

  it("rotates the panel with the controller while preserving its captured orientation offset", () => {
    const initialController = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    const initialOffset = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
    const targetQuaternion = multiplyQuaternions(initialController, initialOffset);
    const nextController = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
    const state = createRayDragState({
      rayOrigin: { x: 0, y: 0, z: 0 },
      rayDirection: { x: 0, y: 0, z: -1 },
      hitPoint: { x: 0, y: 0, z: -2 },
      targetPosition: { x: 0, y: 0, z: -2 },
      targetQuaternion,
      controllerQuaternion: initialController,
    });

    const pose = solveRayDragPose(state, {
      rayOrigin: { x: 0, y: 0, z: 0 },
      rayDirection: { x: -1, y: 0, z: 0 },
      controllerQuaternion: nextController,
    });

    expectQuaternionClose(pose.quaternion, multiplyQuaternions(nextController, initialOffset));
    expectQuaternionClose(
      multiplyQuaternions(inverseQuaternion(nextController), pose.quaternion),
      initialOffset,
    );
  });

  it("captures endpoint distance once and normalizes ray directions for every solve", () => {
    const options = {
      rayOrigin: { x: 0, y: 0, z: 0 },
      hitPoint: { x: 0, y: 0, z: -5 },
      targetPosition: { x: 0, y: 0, z: -5 },
      targetQuaternion: identity,
      controllerQuaternion: identity,
    };
    const normalized = createRayDragState({ ...options, rayDirection: { x: 0, y: 0, z: -1 } });
    const nonNormalized = createRayDragState({ ...options, rayDirection: { x: 0, y: 0, z: -40 } });

    expect(normalized.distance).toBe(5);
    expect(nonNormalized.distance).toBe(5);
    expect(solveRayDragPose(normalized, {
      rayOrigin: { x: 3, y: 4, z: 5 },
      rayDirection: { x: 2, y: 0, z: 0 },
      controllerQuaternion: identity,
    })).toMatchObject({
      rayEndpoint: { x: 8, y: 4, z: 5 },
    });
    expect(solveRayDragPose(nonNormalized, {
      rayOrigin: { x: 3, y: 4, z: 5 },
      rayDirection: { x: 20, y: 0, z: 0 },
      controllerQuaternion: identity,
    })).toMatchObject({
      rayEndpoint: { x: 8, y: 4, z: 5 },
    });
  });

  it("always returns a normalized output quaternion", () => {
    const state = createRayDragState({
      rayOrigin: { x: 0, y: 0, z: 0 },
      rayDirection: { x: 0, y: 0, z: -1 },
      hitPoint: { x: 0, y: 0, z: -1 },
      targetPosition: { x: 0, y: 0, z: -1 },
      targetQuaternion: { x: 0, y: 2, z: 0, w: 2 },
      controllerQuaternion: { x: 0, y: 0, z: 0, w: 3 },
    });

    const pose = solveRayDragPose(state, {
      rayDirection: { x: 0, y: 0, z: -1 },
      controllerQuaternion: { x: 2, y: 0, z: 0, w: 2 },
    });

    expect(Math.hypot(
      pose.quaternion.x,
      pose.quaternion.y,
      pose.quaternion.z,
      pose.quaternion.w,
    )).toBeCloseTo(1, 12);
  });

  it("rejects zero, non-finite, and invalid solve ray directions explicitly", () => {
    const validState = createRayDragState({
      rayOrigin: { x: 0, y: 0, z: 0 },
      rayDirection: { x: 0, y: 0, z: -1 },
      hitPoint: { x: 0, y: 0, z: -1 },
      targetPosition: { x: 0, y: 0, z: -1 },
    });

    expect(() => createRayDragState({ rayDirection: { x: 0, y: 0, z: 0 } })).toThrow(RangeError);
    expect(() => createRayDragState({ rayDirection: { x: Infinity, y: 0, z: 0 } })).toThrow(TypeError);
    expect(() => solveRayDragPose(validState, { rayDirection: { x: 0, y: 0, z: 0 } })).toThrow(RangeError);
    expect(() => solveRayDragPose(validState, { rayDirection: null })).toThrow(TypeError);
  });
});
