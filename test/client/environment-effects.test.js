import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  EnvironmentEffects,
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

  it("uses the normal camera world position outside XR", () => {
    const rig = new THREE.Group();
    rig.position.set(1, 2, 3);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0.5, -0.25, -2);
    rig.add(camera);
    rig.updateMatrixWorld(true);

    const center = cameraWorldCenter(camera);

    expect(center.toArray()).toEqual([1.5, 1.75, 1]);
  });

  it("skips the background pass when the passthrough overlay is disabled", () => {
    const effects = new EnvironmentEffects();
    const mainScene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const renderedScenes = [];
    const renderer = {
      autoClear: true,
      xr: { isPresenting: false },
      setClearColor() {},
      clear() {},
      clearDepth() {
        throw new Error("The direct passthrough path must not clear depth twice.");
      },
      render(scene) {
        renderedScenes.push(scene);
      },
    };

    effects.render(renderer, mainScene, camera, 0);

    expect(renderedScenes).toEqual([mainScene]);
    expect(effects.renderPasses).toMatchObject({
      background: 0,
      main: 1,
      depthClears: 0,
    });
    expect(renderer.autoClear).toBe(true);
    effects.dispose();
  });
});
