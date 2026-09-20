import { afterEach, describe, expect, it } from "vitest";

import { createInteractionHarness } from "./interaction-harness.js";

// LIVE is the panel's current size. The stale restore-derived size that used
// to snap the first two-hand frame no longer exists: scale limits derive from
// the live dimensions, so the harness only sets those.
const LIVE = { width: 0.5, height: 0.3 };

const created = [];
afterEach(() => {
  for (const interaction of created.splice(0)) interaction.dispose();
});

function makeHarness() {
  const harness = createInteractionHarness({
    presenting: true,
    manipulation: {
      type: "panel",
      scalable: true,
      dimensions: { ...LIVE },
    },
  });
  harness.root.userData.minimized = false;
  harness.root.userData.locked = false;
  created.push(harness.interaction);
  return harness;
}

function beginTwoHandGrab({ interaction, controllers, scene }) {
  controllers[0].dispatchEvent({ type: "selectstart" });
  controllers[1].dispatchEvent({ type: "selectstart" });
  scene.updateMatrixWorld(true);
  interaction.update();
}

function lastTwoHandGesture(gestures) {
  const twoHand = gestures.filter(({ gesture }) => gesture.hands === 2);
  expect(twoHand.length).toBeGreaterThan(0);
  return twoHand[twoHand.length - 1].gesture;
}

describe("two-hand panel rescaling baseline", () => {
  it("starts from the live size instead of jumping to the stale restore size", () => {
    const harness = makeHarness();
    beginTwoHandGrab(harness);

    const gesture = lastTwoHandGesture(harness.gestures);
    expect(gesture.scaleFactor).toBeCloseTo(1, 5);
    expect(gesture.absoluteDimensions.width).toBeCloseTo(LIVE.width, 5);
    expect(gesture.absoluteDimensions.height).toBeCloseTo(LIVE.height, 5);
  });

  it("keeps the live size while moving both hands without spreading", () => {
    const harness = makeHarness();
    beginTwoHandGrab(harness);
    const first = lastTwoHandGesture(harness.gestures);

    for (const controller of harness.controllers) controller.position.x += 0.3;
    harness.scene.updateMatrixWorld(true);
    harness.interaction.update();

    const moved = lastTwoHandGesture(harness.gestures);
    expect(moved.absoluteDimensions.width).toBeCloseTo(LIVE.width, 5);
    expect(moved.absoluteDimensions.height).toBeCloseTo(LIVE.height, 5);
    expect(moved.absolutePose.position.x).toBeCloseTo(first.absolutePose.position.x + 0.3, 5);
  });

  it("clamps spread scaling to absolute bounds derived from the live size", () => {
    const harness = makeHarness();
    beginTwoHandGrab(harness);

    harness.controllers[0].position.set(-2, 0, 0);
    harness.controllers[1].position.set(2, 0, 0);
    harness.scene.updateMatrixWorld(true);
    harness.interaction.update();

    const gesture = lastTwoHandGesture(harness.gestures);
    // Live limits allow up to 10x (0.5m -> 5m).
    expect(gesture.scaleFactor).toBeCloseTo(10, 4);
    expect(gesture.absoluteDimensions.width).toBeCloseTo(5, 4);
    expect(gesture.absoluteDimensions.height).toBeCloseTo(3, 4);
  });
});
