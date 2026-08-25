import { describe, expect, it, vi } from "vitest";

import { createScene } from "../../app/src/core/scene-state.js";
import { ScenePlaybackController } from "../../app/src/scene/scene-playback-controller.js";

function panel(id, x = 0) {
  return {
    id,
    media: { directory: "photos", selectedId: `${id}.jpg`, sort: "name", view: "thumbnails" },
    transform: {
      position: { x, y: 1, z: -1 },
      rotation: { x: 0, y: 0, z: 0 },
    },
    dimensions: { width: 1, height: 1 },
  };
}

function controllerFixture({ panels = [panel("a")], now = () => 100 } = {}) {
  const stateChanges = [];
  const transitions = [];
  const cleared = [];
  const api = {
    scenes: vi.fn(() => Promise.resolve({ scenes: [{ id: "scene-1" }] })),
    createScene: vi.fn((name) => Promise.resolve({ id: "scene-1", name, loop: false })),
    saveScene: vi.fn((id, payload) => Promise.resolve({ id, name: "Saved", ...payload })),
    scene: vi.fn(),
  };
  const controller = new ScenePlaybackController({
    api,
    getPanels: () => panels,
    applyPanelSnapshot: (snapshot) => {
      const index = panels.findIndex((item) => item.id === snapshot.id);
      if (index >= 0) panels[index] = structuredClone(snapshot);
      else panels.push(structuredClone(snapshot));
    },
    removePanel: (id) => {
      const index = panels.findIndex((item) => item.id === id);
      if (index >= 0) panels.splice(index, 1);
    },
    applyPanelTransition: (id, step, progress) => transitions.push({ id, step, progress }),
    clearPanelTransition: (id) => cleared.push(id),
    onStateChange: (state) => stateChanges.push(state),
    onError: vi.fn(),
    now,
  });
  return { api, controller, panels, stateChanges, transitions, cleared };
}

describe("ScenePlaybackController", () => {
  it("captures a draft and persists it when creating a named scene", async () => {
    const { api, controller, stateChanges } = controllerFixture();

    const captured = await controller.captureOrDeleteShot();
    expect(captured.shots).toHaveLength(1);
    expect(captured.can_delete_selected_shot).toBe(true);

    const created = await controller.create("Vacation");
    expect(created.id).toBe("scene-1");
    expect(created.shots).toHaveLength(1);
    expect(api.saveScene).toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({ shots: expect.any(Array), current_shot_id: captured.current_shot_id }),
    );
    expect(stateChanges.at(-1)).toEqual(created);
  });

  it("advances playback and applies interpolated panel transitions", async () => {
    const { controller, transitions } = controllerFixture({ now: () => 100 });
    controller.scene = createScene({
      id: "scene-1",
      loop: false,
      current_shot_id: "first",
      shots: [
        { id: "first", duration_sec: 1, panels: [panel("a", 0)] },
        { id: "second", duration_sec: 1, panels: [panel("a", 2)] },
      ],
    });
    controller.playbackActive = true;
    controller.nextAdvanceAt = 200;

    controller.advancePlayback(200);
    await Promise.resolve();
    controller.updateTransition(600);

    expect(controller.getState().current_shot_id).toBe("second");
    expect(controller.nextAdvanceAt).toBe(1100);
    expect(transitions.at(-1)).toEqual(expect.objectContaining({ id: "a", progress: 0.5 }));

    controller.updateTransition(1100);
    expect(controller.transition).toBeNull();
  });
});
