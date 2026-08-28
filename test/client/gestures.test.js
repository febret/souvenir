import { describe, expect, it } from "vitest";
import { createPanel } from "../../app/src/core/panel-store.js";
import { applyPanelGesture, createInteractionState, interactionMode, updateInteractionState } from "../../app/src/core/gestures.js";

describe("gesture rules", () => {
  it("moves and reorients unlocked panels with one hand and rescales with two", () => {
    const panel = createPanel({ id: "panel" });
    const moved = applyPanelGesture(panel, { hands: 1, translation: { x: 2 }, rotation: { y: 0.5 } });
    expect(moved.transform.position.x).toBe(2);
    expect(moved.transform.rotation.y).toBeCloseTo(0.5);
    expect(interactionMode(panel, 2)).toBe("panel-transform");
    const scaled = applyPanelGesture(panel, { hands: 2, scale: 2 });
    expect(scaled.dimensions).toEqual({ width: 2.4, height: 1.6 });
  });

  it("ignores single-hand pinch and rescales only with two hands when locked", () => {
    const panel = createPanel({ id: "panel", locked: true, dimensions: { width: 1.2, height: 0.8 } });
    expect(interactionMode(panel, 1)).toBe("none");
    // Single-hand gestures leave locked panels untouched.
    const untouched = applyPanelGesture(panel, { hands: 1, translation: { x: 10 }, rotation: { y: 3 } });
    expect(untouched.transform).toEqual(panel.transform);
    expect(untouched.dimensions).toEqual(panel.dimensions);
    // Two-hand pinch rescales but never moves or reorients.
    expect(interactionMode(panel, 2)).toBe("panel-rescale");
    const scaled = applyPanelGesture(panel, { hands: 2, scale: 2, translation: { x: 10 } });
    expect(scaled.dimensions).toEqual({ width: 2.4, height: 1.6 });
    expect(scaled.transform).toEqual(panel.transform);
  });

  it("disables pinch interactions in zen mode", () => {
    const panel = createPanel({ id: "panel" });
    expect(interactionMode(panel, 1, { zen: true })).toBe("none");
    expect(interactionMode(panel, 2, { zen: true })).toBe("none");
    const untouched = applyPanelGesture(panel, { hands: 2, scale: 4 }, {}, { zen: true });
    expect(untouched.dimensions).toEqual(panel.dimensions);
  });

  it("tracks interaction ownership and resets cleanly", () => {
    const active = updateInteractionState(createInteractionState(), { type: "begin", panelId: "panel", hands: 2 });
    expect(active).toEqual({ panelId: "panel", hands: 2 });
    expect(updateInteractionState(active, { type: "end" })).toEqual({ panelId: null, hands: 0 });
  });
});
