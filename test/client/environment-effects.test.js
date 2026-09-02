import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  cameraWorldCenter,
} from "../../app/src/scene/environment-effects.js";

describe("environment XR view position", () => {
  it("uses the midpoint of the current stereo eye poses", () => {
    const left = new THREE.PerspectiveCamera();
    const right = new THREE.PerspectiveCamera();
    left.position.set(2.94, 1.7, -4);
    right.position.set(3.06, 1.7, -4);
    left.updateMatrixWorld();
    right.updateMatrixWorld();
    const xrCamera = new THREE.ArrayCamera([left, right]);

    const center = cameraWorldCenter(xrCamera);

    expect(center.x).toBeCloseTo(3);
    expect(center.y).toBeCloseTo(1.7);
    expect(center.z).toBeCloseTo(-4);
  });
});
