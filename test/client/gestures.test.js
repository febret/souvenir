import { describe, expect, it } from "vitest";
import { createPanel } from "../../app/src/core/panel-store.js";
import { applyPanelGesture, createInteractionState, interactionMode, updateInteractionState } from "../../app/src/core/gestures.js";

describe("gesture rules", () => {
  it("moves and reorients unlocked panels with one hand and resizes with two", () => {
    const panel = createPanel({ id: "panel" });
    const moved = applyPanelGesture(panel, { hands: 1, translation: { x: 2 }, rotation: { y: 0.5 } });
    expect(moved.transform.position.x).toBe(2);
    expect(moved.transform.rotation.y).toBeCloseTo(0.5);
    expect(applyPanelGesture(panel, { hands: 2, scale: 2 }).dimensions).toEqual({ width: 2.4, height: 1.6 });
    expect(interactionMode(panel, 2)).toBe("panel-resize");
  });

  it("pans and zooms content for locked or zoom-mode panels with clamps", () => {
    const panel = createPanel({ id: "panel", locked: true });
    const panned = applyPanelGesture(panel, { hands: 1, translation: { x: 10 } });
    expect(panned.content.pan.x).toBe(3);
    expect(applyPanelGesture(panel, { hands: 2, scale: 100 }).content.zoom).toBe(8);
    expect(interactionMode({ ...panel, locked: false, zoomMode: true }, 1)).toBe("content-pan");
  });

  it("allows minimized panels to move while preventing resize", () => {
    const panel = createPanel({ id: "panel", minimized: true });
    const moved = applyPanelGesture(panel, { hands: 1, translation: { y: 1 } });
    expect(moved.transform.position.y).toBe(1);
    expect(applyPanelGesture(panel, { hands: 2, scale: 4 }).dimensions).toEqual(panel.dimensions);
  });

  it("tracks interaction ownership and resets cleanly", () => {
    const active = updateInteractionState(createInteractionState(), { type: "begin", panelId: "panel", hands: 2 });
    expect(active).toEqual({ panelId: "panel", hands: 2 });
    expect(updateInteractionState(active, { type: "end" })).toEqual({ panelId: null, hands: 0 });
  });
});
