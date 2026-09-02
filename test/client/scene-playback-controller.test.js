import { describe, expect, it, vi } from "vitest";

import { ScenePlaybackController } from "../../app/src/scene/scene-playback-controller.js";

function panel(id) {
  return {
    id,
    media: { directory: "photos", selectedId: `${id}.jpg`, sort: "name", view: "thumbnails" },
    transform: {
      position: { x: 0, y: 1, z: -1 },
      rotation: { x: 0, y: 0, z: 0 },
    },
    dimensions: { width: 1, height: 1 },
  };
}

function controllerFixture({ panels = [panel("a")] } = {}) {
  const stateChanges = [];
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
    applyPanelTransition() {},
    clearPanelTransition() {},
    onStateChange: (state) => stateChanges.push(state),
    onError: vi.fn(),
    now: () => 100,
  });
  return { api, controller, panels, stateChanges };
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
});
