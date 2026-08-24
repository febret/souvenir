import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";

import {
  InteractionController,
  snapshotXrControllerRay,
} from "../../app/src/scene/interaction-controller.js";
import {
  createRayDragState,
  solveRayDragPose,
} from "../../app/src/core/ray-drag.js";
import {
  createTwoHandRayDragState,
  solveTwoHandRayDragPose,
} from "../../app/src/core/two-hand-ray-drag.js";

function controller(origin, direction) {
  return {
    origin: new THREE.Vector3(...origin),
    direction: new THREE.Vector3(...direction),
  };
}

function hand(snapshot, hitPoint, localAnchor) {
  return { ...snapshot, hitPoint, localAnchor };
}

function expectVectorClose(actual, expected) {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
  expect(actual.z).toBeCloseTo(expected.z, 10);
}

function worldAnchor(pose, anchor) {
  return new THREE.Vector3(anchor.x, anchor.y, anchor.z)
    .multiply(pose.targetScale)
    .applyQuaternion(new THREE.Quaternion(
      pose.quaternion.x,
      pose.quaternion.y,
      pose.quaternion.z,
      pose.quaternion.w,
    ))
    .add(new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z));
}

describe("XR controller ray snapshots", () => {
  it("releases XR listeners, rays, and scene nodes on disposal", () => {
    const controllers = [new THREE.Group(), new THREE.Group()];
    const hands = [new THREE.Group(), new THREE.Group()];
    const removeListeners = controllers.map((item) => vi.spyOn(item, "removeEventListener"));
    const canvas = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const scene = new THREE.Scene();
    const interaction = new InteractionController({
      renderer: {
        xr: {
          getController: (index) => controllers[index],
          getHand: (index) => hands[index],
        },
      },
      camera: new THREE.PerspectiveCamera(),
      scene,
      canvas,
    });
    const disposeGeometry = vi.spyOn(interaction.xrRayGeometry, "dispose");
    const disposeMaterials = interaction.xrRays.map((ray) => vi.spyOn(ray.material, "dispose"));

    interaction.dispose();

    expect(removeListeners[0]).toHaveBeenCalledTimes(2);
    expect(removeListeners[1]).toHaveBeenCalledTimes(2);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    for (const disposeMaterial of disposeMaterials) {
      expect(disposeMaterial).toHaveBeenCalledOnce();
    }
    expect(scene.children).toEqual([]);
    expect(interaction.xrControllers).toEqual([]);
    expect(interaction.xrHands).toEqual([]);
  });

  it("keeps independently captured hand rays when the raycaster reuses its vectors", () => {
    const raycaster = {
      ray: new THREE.Ray(new THREE.Vector3(), new THREE.Vector3()),
      setFromXRController(activeController) {
        this.ray.origin.copy(activeController.origin);
        this.ray.direction.copy(activeController.direction);
      },
    };
    const firstController = controller([-1, 0, 3], [0, 0, -1]);
    const secondController = controller([1, 0, 3], [0, 0, -1]);

    const firstSnapshot = snapshotXrControllerRay(raycaster, firstController);
    const secondSnapshot = snapshotXrControllerRay(raycaster, secondController);

    expect(firstSnapshot.rayOrigin).not.toBe(raycaster.ray.origin);
    expect(firstSnapshot.rayDirection).not.toBe(raycaster.ray.direction);
    expect(secondSnapshot.rayOrigin).not.toBe(firstSnapshot.rayOrigin);
    expect(secondSnapshot.rayDirection).not.toBe(firstSnapshot.rayDirection);
    expect(firstSnapshot.rayOrigin).toEqual(new THREE.Vector3(-1, 0, 3));
    expect(firstSnapshot.rayDirection).toEqual(new THREE.Vector3(0, 0, -1));
    expect(secondSnapshot.rayOrigin).toEqual(new THREE.Vector3(1, 0, 3));
    expect(secondSnapshot.rayDirection).toEqual(new THREE.Vector3(0, 0, -1));

    const state = createTwoHandRayDragState({
      first: hand(firstSnapshot, { x: -1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }),
      second: hand(secondSnapshot, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }),
      targetPosition: { x: 0, y: 0, z: 0 },
      targetQuaternion: { x: 0, y: 0, z: 0, w: 1 },
      targetScale: { x: 1, y: 1, z: 1 },
    });

    firstController.origin.set(8, 5, 4);
    secondController.origin.set(12, 5, 4);
    const pose = solveTwoHandRayDragPose(state, {
      first: snapshotXrControllerRay(raycaster, firstController),
      second: snapshotXrControllerRay(raycaster, secondController),
    });

    expect(pose.targetScale).toEqual({ x: 2, y: 2, z: 2 });
    expectVectorClose(pose.firstEndpoint, { x: 8, y: 5, z: 1 });
    expectVectorClose(pose.secondEndpoint, { x: 12, y: 5, z: 1 });
    expectVectorClose(worldAnchor(pose, state.first.localAnchor), pose.firstEndpoint);
    expectVectorClose(worldAnchor(pose, state.second.localAnchor), pose.secondEndpoint);
  });

  it("rebases the remaining hand to the resized anchor without a pose snap", () => {
    const pair = createTwoHandRayDragState({
      first: {
        rayOrigin: { x: -0.5, y: 0, z: 3 },
        rayDirection: { x: 0, y: 0, z: -1 },
        hitPoint: { x: -0.5, y: 0, z: 0 },
        localAnchor: { x: -0.5, y: 0, z: 0 },
      },
      second: {
        rayOrigin: { x: 0.5, y: 0, z: 3 },
        rayDirection: { x: 0, y: 0, z: -1 },
        hitPoint: { x: 0.5, y: 0, z: 0 },
        localAnchor: { x: 0.5, y: 0, z: 0 },
      },
      targetPosition: { x: 0, y: 0, z: 0 },
      targetQuaternion: { x: 0, y: 0, z: 0, w: 1 },
      targetScale: { x: 1, y: 1, z: 1 },
    });
    const resized = solveTwoHandRayDragPose(pair, {
      first: {
        rayOrigin: { x: -1, y: 0, z: 3 },
        rayDirection: { x: 0, y: 0, z: -1 },
      },
      second: {
        rayOrigin: { x: 1, y: 0, z: 3 },
        rayDirection: { x: 0, y: 0, z: -1 },
      },
    });
    const root = new THREE.Object3D();
    root.position.set(resized.position.x, resized.position.y, resized.position.z);
    root.quaternion.set(
      resized.quaternion.x,
      resized.quaternion.y,
      resized.quaternion.z,
      resized.quaternion.w,
    );
    root.updateMatrixWorld(true);
    const endpoint = new THREE.Vector3(
      resized.firstEndpoint.x,
      resized.firstEndpoint.y,
      resized.firstEndpoint.z,
    );
    const rebasedAnchor = root.worldToLocal(endpoint.clone());
    expect(rebasedAnchor.x).toBeCloseTo(-1);

    const oneHand = createRayDragState({
      rayOrigin: { x: -1, y: 0, z: 3 },
      rayDirection: { x: 0, y: 0, z: -1 },
      hitPoint: resized.firstEndpoint,
      targetPosition: resized.position,
      targetQuaternion: resized.quaternion,
      targetScale: { x: 1, y: 1, z: 1 },
      localAnchor: rebasedAnchor,
      controllerQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    });
    const unchanged = solveRayDragPose(oneHand, {
      rayOrigin: { x: -1, y: 0, z: 3 },
      rayDirection: { x: 0, y: 0, z: -1 },
      controllerQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    });

    expectVectorClose(unchanged.position, resized.position);
    const moved = solveRayDragPose(oneHand, {
      rayOrigin: { x: -0.8, y: 0.25, z: 3 },
      rayDirection: { x: 0, y: 0, z: -1 },
      controllerQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    });
    expectVectorClose(moved.position, {
      x: resized.position.x + 0.2,
      y: resized.position.y + 0.25,
      z: resized.position.z,
    });
  });
});
