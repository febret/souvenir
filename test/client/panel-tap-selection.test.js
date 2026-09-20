import { afterEach, describe, expect, it } from "vitest";

import { createInteractionHarness, pointerEvent } from "./interaction-harness.js";

const created = [];
afterEach(() => {
  for (const interaction of created.splice(0)) interaction.dispose();
});

function makeHarness() {
  const harness = createInteractionHarness({
    surfaceKind: "panel-surface",
  });
  created.push(harness.interaction);
  return harness;
}

const PANEL_POINT = { clientX: 400, clientY: 300 };
const EMPTY_POINT = { clientX: 790, clientY: 590 };

describe("tap-only panel selection", () => {
  it("treats hover as inert: no activation and no background deselect", () => {
    const { interaction, activates, backgrounds } = makeHarness();
    interaction.onPointerMove(pointerEvent(PANEL_POINT.clientX, PANEL_POINT.clientY));
    interaction.onPointerMove(pointerEvent(EMPTY_POINT.clientX, EMPTY_POINT.clientY));
    expect(activates).toHaveLength(0);
    expect(backgrounds).toHaveLength(0);
  });

  it("routes a clean tap on a panel to activation (selection happens there)", () => {
    const { interaction, activates, backgrounds } = makeHarness();
    interaction.onPointerDown(pointerEvent(PANEL_POINT.clientX, PANEL_POINT.clientY));
    interaction.onPointerUp(pointerEvent(PANEL_POINT.clientX, PANEL_POINT.clientY));
    expect(activates).toHaveLength(1);
    expect(activates[0].hit.object.userData.panelId).toBe("panel-1");
    expect(activates[0].context).toMatchObject({ source: "desktop-pointer" });
    expect(backgrounds).toHaveLength(0);
  });

  it("does not activate after a drag, so moving a panel never selects it", () => {
    const { interaction, activates, backgrounds, gestures } = makeHarness();
    interaction.onPointerDown(pointerEvent(PANEL_POINT.clientX, PANEL_POINT.clientY));
    interaction.onPointerMove(pointerEvent(420, 300));
    interaction.onPointerMove(pointerEvent(460, 320));
    interaction.onPointerUp(pointerEvent(460, 320));
    expect(activates).toHaveLength(0);
    expect(backgrounds).toHaveLength(0);
    expect(gestures.length).toBeGreaterThan(0);
  });

  it("routes a clean tap on empty space to background deselect", () => {
    const { interaction, activates, backgrounds } = makeHarness();
    interaction.onPointerDown(pointerEvent(EMPTY_POINT.clientX, EMPTY_POINT.clientY));
    interaction.onPointerUp(pointerEvent(EMPTY_POINT.clientX, EMPTY_POINT.clientY));
    expect(activates).toHaveLength(0);
    expect(backgrounds).toHaveLength(1);
    expect(backgrounds[0]).toMatchObject({ source: "desktop-pointer" });
  });

  it("does not deselect after dragging on empty space (orbit keeps working)", () => {
    const { interaction, backgrounds } = makeHarness();
    interaction.onPointerDown(pointerEvent(EMPTY_POINT.clientX, EMPTY_POINT.clientY));
    interaction.onPointerMove(pointerEvent(500, 400));
    interaction.onPointerUp(pointerEvent(500, 400));
    expect(backgrounds).toHaveLength(0);
  });

  it("resizes with the wheel without activating", () => {
    const { interaction, activates, backgrounds, gestures } = makeHarness();
    interaction.onWheel(pointerEvent(PANEL_POINT.clientX, PANEL_POINT.clientY, { deltaY: -100 }));
    expect(activates).toHaveLength(0);
    expect(backgrounds).toHaveLength(0);
    expect(gestures).toHaveLength(1);
    expect(gestures[0].target).toBe("panel-1");
  });
});

describe("XR background pinch", () => {
  // Controllers far off-axis miss the panel, so selectstart tracks a
  // background press. Regression: the press used to enter xrGrabs without
  // drag state, and update() threw every frame while it was held (TypeError
  // on missing lastPosition), freezing the passthrough render loop.
  function makeXrHarness(controllerPositions) {
    const harness = createInteractionHarness({
      presenting: true,
      surfaceKind: "panel-surface",
      controllerPositions,
    });
    created.push(harness.interaction);
    return harness;
  }

  it("holding a background pinch never throws in the frame loop, then deselects on release", () => {
    const { interaction, controllers, activates, backgrounds, gestures } = makeXrHarness([
      [5, 0, 0],
      [-5, 0, 0],
    ]);
    controllers[0].dispatchEvent({ type: "selectstart" });
    expect(interaction.xrEmptyPress.size).toBe(1);
    expect(interaction.xrGrabs.size).toBe(0);
    expect(() => {
      for (let frame = 0; frame < 5; frame += 1) interaction.update();
    }).not.toThrow();
    expect(gestures).toHaveLength(0);
    expect(activates).toHaveLength(0);
    controllers[0].dispatchEvent({ type: "selectend" });
    expect(backgrounds).toHaveLength(1);
    expect(backgrounds[0]).toMatchObject({ source: "xr-select" });
  });

  it("a background pinch does not disturb the other hand's panel drag", () => {
    const { interaction, controllers, scene, activates, backgrounds, gestures } = makeXrHarness([
      [5, 0, 0],
      [0, 0, 0],
    ]);
    controllers[0].dispatchEvent({ type: "selectstart" });
    controllers[1].dispatchEvent({ type: "selectstart" });
    scene.updateMatrixWorld(true);
    expect(() => {
      for (let frame = 0; frame < 3; frame += 1) interaction.update();
    }).not.toThrow();
    expect(gestures.every(({ target }) => target === "panel-1")).toBe(true);

    // Drag the panel hand: movement means no tap activation on release.
    controllers[1].position.x += 0.3;
    scene.updateMatrixWorld(true);
    interaction.update();
    controllers[1].dispatchEvent({ type: "selectend" });
    expect(activates).toHaveLength(0);

    // Releasing the held background pinch with no active grab deselects.
    controllers[0].dispatchEvent({ type: "selectend" });
    expect(backgrounds).toHaveLength(1);
  });

  it("a background release while the other hand holds content keeps the selection", () => {
    const { interaction, controllers, scene, backgrounds } = makeXrHarness([
      [5, 0, 0],
      [0, 0, 0],
    ]);
    controllers[0].dispatchEvent({ type: "selectstart" });
    controllers[1].dispatchEvent({ type: "selectstart" });
    scene.updateMatrixWorld(true);
    controllers[0].dispatchEvent({ type: "selectend" });
    expect(backgrounds).toHaveLength(0);
    expect(interaction.xrEmptyPress.size).toBe(0);
    expect(interaction.xrGrabs.size).toBe(1);
  });
});
