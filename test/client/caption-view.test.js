import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { CaptionView } from "../../app/src/scene/caption-view.js";

describe("CaptionView", () => {
  it("stays at a fixed forward distance with the viewer orientation", () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(1, 2, 3);
    camera.rotation.set(0.1, 0.4, -0.05);
    camera.updateMatrixWorld(true);
    const expectedOrientation = camera.getWorldQuaternion(new THREE.Quaternion());
    const expectedForward = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(expectedOrientation);
    const view = new CaptionView();

    view.setStyle({ size: 1.5, transparency: 0.25 });
    view.updatePose(camera, 1.8);

    const offset = view.position.clone().sub(camera.position);
    expect(offset.length()).toBeCloseTo(1.8);
    expect(offset.normalize().dot(expectedForward)).toBeCloseTo(1);
    expect(1 - Math.abs(view.quaternion.dot(expectedOrientation))).toBeCloseTo(0);
    expect(view.scale.toArray()).toEqual([1.5, 1.5, 1.5]);
    expect(view.material.opacity).toBe(0.75);
    view.dispose();
  });
});
