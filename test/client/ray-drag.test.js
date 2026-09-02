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

describe("anchored ray dragging", () => {
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
