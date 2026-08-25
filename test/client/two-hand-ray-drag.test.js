import { describe, expect, it } from "vitest";
import {
  createTwoHandRayFrame,
  createTwoHandRayDragState,
  solveTwoHandRayDragPose,
} from "../../app/src/core/two-hand-ray-drag.js";

const identity = { x: 0, y: 0, z: 0, w: 1 };

function rotate(value, quaternion) {
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

function add(left, right) {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function worldAnchor(position, quaternion, scale, anchor) {
  return add(position, rotate({
    x: anchor.x * scale.x,
    y: anchor.y * scale.y,
    z: anchor.z * scale.z,
  }, quaternion));
}

function expectVectorClose(actual, expected) {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
  expect(actual.z).toBeCloseTo(expected.z, 10);
}

function hand(endpoint, anchor, distance = 3, direction = { x: 0, y: 0, z: -1 }) {
  return {
    rayOrigin: {
      x: endpoint.x - direction.x * distance,
      y: endpoint.y - direction.y * distance,
      z: endpoint.z - direction.z * distance,
    },
    rayDirection: direction,
    hitPoint: endpoint,
    localAnchor: anchor,
  };
}

function centeredState(overrides = {}) {
  return createTwoHandRayDragState({
    first: hand({ x: -1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }),
    second: hand({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }),
    targetPosition: { x: 0, y: 0, z: 0 },
    targetQuaternion: identity,
    targetScale: { x: 1, y: 1, z: 1 },
    ...overrides,
  });
}

describe("two-hand ray dragging", () => {
  it("maps canonical axes onto a general tilted hand frame", () => {
    const frame = createTwoHandRayFrame(
      { x: -1, y: -0.5, z: 0.2 },
      { x: 2, y: 1, z: 1.5 },
      { x: 0.2, y: 0.1, z: -1 },
      { x: -0.1, y: 0.3, z: -1 },
      { x: 0, y: 0, z: 1 },
    );

    expectVectorClose(rotate({ x: 1, y: 0, z: 0 }, frame.quaternion), frame.x);
    expectVectorClose(rotate({ x: 0, y: 1, z: 0 }, frame.quaternion), frame.y);
    expectVectorClose(rotate({ x: 0, y: 0, z: 1 }, frame.quaternion), frame.z);
  });

  it("returns the exact initial pose", () => {
    const state = centeredState();
    const pose = solveTwoHandRayDragPose(state, {
      first: { rayOrigin: state.first.rayOrigin, rayDirection: state.first.rayDirection },
      second: { rayOrigin: state.second.rayOrigin, rayDirection: state.second.rayDirection },
    });

    expect(pose.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(pose.quaternion).toEqual(identity);
    expect(pose.targetScale).toEqual({ x: 1, y: 1, z: 1 });
    expect(pose.scaleFactor).toBe(1);
  });

  it("maps both off-center local anchors to their ray endpoints", () => {
    const position = { x: 4, y: -2, z: 1 };
    const quaternion = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
    const scale = { x: 2, y: 3, z: 4 };
    const firstAnchor = { x: -0.5, y: 0.2, z: 0 };
    const secondAnchor = { x: 0.5, y: -0.2, z: 0 };
    const firstEndpoint = worldAnchor(position, quaternion, scale, firstAnchor);
    const secondEndpoint = worldAnchor(position, quaternion, scale, secondAnchor);
    const state = createTwoHandRayDragState({
      first: hand(firstEndpoint, firstAnchor),
      second: hand(secondEndpoint, secondAnchor),
      targetPosition: position,
      targetQuaternion: quaternion,
      targetScale: scale,
    });
    const pose = solveTwoHandRayDragPose(state, {
      first: { rayOrigin: state.first.rayOrigin, rayDirection: state.first.rayDirection },
      second: { rayOrigin: state.second.rayOrigin, rayDirection: state.second.rayDirection },
    });

    expectVectorClose(worldAnchor(pose.position, pose.quaternion, pose.targetScale, firstAnchor), pose.firstEndpoint);
    expectVectorClose(worldAnchor(pose.position, pose.quaternion, pose.targetScale, secondAnchor), pose.secondEndpoint);
  });

  it("preserves each independently captured projected ray length", () => {
    const state = centeredState({
      first: hand({ x: -1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, 2),
      second: hand({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 7),
    });
    const pose = solveTwoHandRayDragPose(state, {
      first: { rayOrigin: { x: 1, y: 2, z: 8 }, rayDirection: { x: 0, y: 0, z: -4 } },
      second: { rayOrigin: { x: 5, y: 2, z: 7 }, rayDirection: { x: 0, y: 0, z: -2 } },
    });

    expect(pose.firstEndpoint).toEqual({ x: 1, y: 2, z: 6 });
    expect(pose.secondEndpoint).toEqual({ x: 5, y: 2, z: 0 });
  });

  it("translates and rotates with the two-ray frame", () => {
    const state = centeredState();
    const quarterTurn = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
    const translation = { x: 5, y: -4, z: 2 };
    const firstEndpoint = add(translation, rotate({ x: -1, y: 0, z: 0 }, quarterTurn));
    const secondEndpoint = add(translation, rotate({ x: 1, y: 0, z: 0 }, quarterTurn));
    const pose = solveTwoHandRayDragPose(state, {
      first: { rayOrigin: add(firstEndpoint, { x: 0, y: 0, z: 3 }), rayDirection: { x: 0, y: 0, z: -1 } },
      second: { rayOrigin: add(secondEndpoint, { x: 0, y: 0, z: 3 }), rayDirection: { x: 0, y: 0, z: -1 } },
    });

    expectVectorClose(pose.position, translation);
    expectVectorClose(rotate({ x: 1, y: 0, z: 0 }, pose.quaternion), { x: 0, y: 1, z: 0 });
  });

  it("uniformly scales with pinch spread and clamps that scale", () => {
    const state = centeredState({ scaleLimits: { min: 0.75, max: 1.5 } });
    const spread = solveTwoHandRayDragPose(state, {
      first: { rayOrigin: { x: -2, y: 0, z: 3 }, rayDirection: { x: 0, y: 0, z: -1 } },
      second: { rayOrigin: { x: 2, y: 0, z: 3 }, rayDirection: { x: 0, y: 0, z: -1 } },
    });
    const clamped = solveTwoHandRayDragPose(state, {
      first: { rayOrigin: { x: -5, y: 0, z: 3 }, rayDirection: { x: 0, y: 0, z: -1 } },
      second: { rayOrigin: { x: 5, y: 0, z: 3 }, rayDirection: { x: 0, y: 0, z: -1 } },
    });

    expect(spread.scaleFactor).toBe(1.5);
    expect(spread.targetScale).toEqual({ x: 1.5, y: 1.5, z: 1.5 });
    expect(clamped.scaleFactor).toBe(1.5);
  });

  it("keeps the captured pose and applies only scale when lockPose is set", () => {
    const position = { x: 1, y: -2, z: -4 };
    const quaternion = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
    const firstAnchor = { x: -0.5, y: 0.2, z: 0 };
    const secondAnchor = { x: 0.5, y: -0.2, z: 0 };
    const firstEndpoint = worldAnchor(position, quaternion, { x: 1, y: 1, z: 1 }, firstAnchor);
    const secondEndpoint = worldAnchor(position, quaternion, { x: 1, y: 1, z: 1 }, secondAnchor);
    const state = createTwoHandRayDragState({
      first: hand(firstEndpoint, firstAnchor),
      second: hand(secondEndpoint, secondAnchor),
      targetPosition: position,
      targetQuaternion: quaternion,
      targetScale: { x: 1, y: 1, z: 1 },
      scaleLimits: { min: 0.5, max: 3 },
      lockPose: true,
    });
    const pose = solveTwoHandRayDragPose(state, {
      first: { rayOrigin: add(firstEndpoint, { x: 0, y: 0, z: 3 }), rayDirection: { x: 0, y: 0, z: -1 } },
      second: { rayOrigin: add(secondEndpoint, { x: 0, y: 0, z: 3 }), rayDirection: { x: 0, y: 0, z: -1 } },
    });

    expect(pose.position).toEqual(position);
    expectVectorClose({ x: pose.quaternion.x, y: 0, z: pose.quaternion.z, w: pose.quaternion.w }, { x: 0, y: 0, z: quaternion.z, w: quaternion.w });
    expect(pose.scaleFactor).toBe(1);
    expect(pose.targetScale).toEqual({ x: 1, y: 1, z: 1 });
  });

  it("retains nonuniform initial target scale while scaling uniformly", () => {
    const state = centeredState({
      targetScale: { x: 2, y: 3, z: 4 },
      first: hand({ x: -2, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }),
      second: hand({ x: 2, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }),
    });
    const pose = solveTwoHandRayDragPose(state, {
      first: { rayOrigin: { x: -3, y: 0, z: 3 }, rayDirection: { x: 0, y: 0, z: -1 } },
      second: { rayOrigin: { x: 3, y: 0, z: 3 }, rayDirection: { x: 0, y: 0, z: -1 } },
    });

    expect(pose.scaleFactor).toBe(1.5);
    expect(pose.targetScale).toEqual({ x: 3, y: 4.5, z: 6 });
  });

  it("stably handles reversed and nearly degenerate average ray directions", () => {
    const state = centeredState({
      first: hand({ x: -1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, 3, { x: 0, y: 0, z: 1 }),
      second: hand({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 3, { x: 0, y: 0, z: -1 }),
    });
    const pose = solveTwoHandRayDragPose(state, {
      first: { rayOrigin: { x: -1, y: 0, z: -3 }, rayDirection: { x: 0, y: 0, z: 1 } },
      second: { rayOrigin: { x: 1, y: 0, z: 3 }, rayDirection: { x: 1e-14, y: 0, z: -1 } },
    });

    expect(Object.values(pose.quaternion).every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...Object.values(pose.quaternion))).toBeCloseTo(1, 12);
  });

  it("keeps the captured frame orientation when current ray directions cancel", () => {
    const initialDirection = { x: 0, y: 0.2873478855663454, z: -0.9578262852211513 };
    const state = centeredState({
      first: hand({ x: -1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, 3, initialDirection),
      second: hand({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 3, initialDirection),
    });
    const pose = solveTwoHandRayDragPose(state, {
      first: {
        rayOrigin: { x: -1, y: 0, z: -state.first.distance },
        rayDirection: { x: 0, y: 0, z: 1 },
      },
      second: {
        rayOrigin: { x: 1, y: 0, z: state.second.distance },
        rayDirection: { x: 0, y: 0, z: -1 },
      },
    });

    expect(pose.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(pose.quaternion.x).toBeCloseTo(0, 10);
    expect(pose.quaternion.y).toBeCloseTo(0, 10);
    expect(pose.quaternion.z).toBeCloseTo(0, 10);
    expect(Math.abs(pose.quaternion.w)).toBeCloseTo(1, 10);
  });

  it("normalizes output quaternions and rejects invalid directions or coincident captures", () => {
    const state = centeredState({
      targetQuaternion: { x: 0, y: 0, z: 2, w: 2 },
      first: hand({ x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }),
      second: hand({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }),
    });
    const pose = solveTwoHandRayDragPose(state, {
      first: { rayOrigin: { x: 0, y: -1, z: 3 }, rayDirection: { x: 0, y: 0, z: -1 } },
      second: { rayOrigin: { x: 0, y: 1, z: 3 }, rayDirection: { x: 0, y: 0, z: -1 } },
    });

    expect(Math.hypot(...Object.values(pose.quaternion))).toBeCloseTo(1, 12);
    expect(() => solveTwoHandRayDragPose(state, {
      first: { rayOrigin: { x: 0, y: 0, z: 0 }, rayDirection: { x: 0, y: 0, z: 0 } },
      second: { rayOrigin: { x: 1, y: 0, z: 0 }, rayDirection: { x: 0, y: 0, z: -1 } },
    })).toThrow(RangeError);
    expect(() => solveTwoHandRayDragPose(state, {
      first: { rayOrigin: { x: 0, y: 0, z: 0 }, rayDirection: { x: Infinity, y: 0, z: 0 } },
      second: { rayOrigin: { x: 1, y: 0, z: 0 }, rayDirection: { x: 0, y: 0, z: -1 } },
    })).toThrow(TypeError);
    expect(() => centeredState({
      first: hand({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
      second: hand({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    })).toThrow(RangeError);
  });
});
