import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCENE_DURATION_SEC,
  captureShotFromPanels,
  createScene,
  createSceneShot,
  sceneShotPayload,
} from "../../app/src/core/scene-state.js";

describe("scene state helpers", () => {
  it("normalizes scene and shot durations with bounds", () => {
    const shot = createSceneShot({
      id: "shot-1",
      duration_sec: 600,
      panels: [],
    });
    expect(shot.duration_sec).toBe(60);
    expect(createScene({ default_duration_sec: 0 }).default_duration_sec).toBe(1);
  });

  it("captures panel snapshots while excluding minimized panels", () => {
    const shot = captureShotFromPanels([
      {
        id: "panel-a",
        minimized: true,
        media: { directory: "albums", selectedId: "albums/a.jpg", sort: "name", view: "thumbnails" },
        transform: { position: { x: 1, y: 2, z: -3 }, rotation: { x: 0, y: 0.1, z: 0 } },
        dimensions: { width: 1.8, height: 1.2 },
      },
      {
        id: "panel-b",
        media: { directory: "albums", selectedId: "albums/b.jpg", sort: "name", view: "thumbnails" },
        transform: { position: { x: 0, y: 1.3, z: -1.4 }, rotation: { x: 0, y: 0, z: 0 } },
        dimensions: { width: 1.2, height: 0.8 },
      },
    ], { durationSec: DEFAULT_SCENE_DURATION_SEC });
    expect(shot.panels).toHaveLength(1);
    expect(shot.panels[0].id).toBe("panel-b");
  });

  it("builds payloads with normalized shot references", () => {
    const scene = createScene({
      id: "scene-1",
      name: "Trip",
      loop: true,
      default_duration_sec: 8,
      current_shot_id: "s1",
      shots: [{ id: "s1", duration_sec: 8, panels: [] }],
    });
    expect(sceneShotPayload(scene)).toEqual({
      loop: true,
      default_duration_sec: 8,
      current_shot_id: "s1",
      shots: [{ id: "s1", duration_sec: 8, panels: [] }],
    });
  });
});
