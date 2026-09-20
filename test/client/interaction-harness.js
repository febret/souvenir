import * as THREE from "three";
import { vi } from "vitest";

import { InteractionController } from "../../app/src/scene/interaction-controller.js";
import { markInteractive } from "../../app/src/scene/canvas-ui.js";

/**
 * Shared InteractionController harness for client tests. Builds a scene with
 * one interactive panel surface facing a centered camera, plus mocked canvas
 * and XR controllers. Callers own disposal via the returned `interaction`.
 */
export function createInteractionHarness({
  presenting = false,
  panelId = "panel-1",
  surfaceSize = 1.4,
  surfaceKind = null,
  manipulation = { type: "panel" },
  controllerPositions = [[-0.2, 0, 0], [0.2, 0, 0]],
} = {}) {
  const controllers = [new THREE.Group(), new THREE.Group()];
  const hands = [new THREE.Group(), new THREE.Group()];
  const canvas = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
    releasePointerCapture: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 100);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -2);
  const activates = [];
  const backgrounds = [];
  const gestures = [];
  const interaction = new InteractionController({
    renderer: {
      xr: {
        isPresenting: presenting,
        getController: (index) => controllers[index],
        getHand: (index) => hands[index],
      },
    },
    camera,
    scene,
    canvas,
    onActivate: (hit, context) => activates.push({ hit, context }),
    onGesture: (target, gesture) => gestures.push({ target, gesture }),
    onBackgroundActivate: (context) => backgrounds.push(context),
  });

  const root = new THREE.Group();
  root.position.set(0, 0, -2);
  root.userData.gestureTarget = panelId;
  root.userData.panelId = panelId;
  root.userData.manipulation = { ...manipulation };
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(surfaceSize, surfaceSize));
  markInteractive(surface);
  if (surfaceKind) surface.userData.kind = surfaceKind;
  surface.userData.panelId = panelId;
  root.add(surface);
  scene.add(root);

  controllers.forEach((controller, index) => {
    const [x = 0, y = 0, z = 0] = controllerPositions[index] ?? [];
    controller.position.set(x, y, z);
  });
  scene.updateMatrixWorld(true);
  return {
    interaction,
    controllers,
    hands,
    canvas,
    scene,
    camera,
    root,
    surface,
    activates,
    backgrounds,
    gestures,
  };
}

export function pointerEvent(clientX, clientY, overrides = {}) {
  return {
    clientX,
    clientY,
    pointerId: 1,
    stopImmediatePropagation: vi.fn(),
    preventDefault: vi.fn(),
    ...overrides,
  };
}
