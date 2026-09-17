import { describe, expect, it } from "vitest";
import {
  CLONE_SIDE_GAP,
  buildClonePanelPayload,
  createPanel,
} from "../../app/src/core/panel-store.js";

function sourcePanel(overrides = {}) {
  return createPanel({
    id: "source",
    media: { directory: "albums", selectedId: "albums/beach.jpg", sort: "mtime", view: "grid" },
    transform: {
      position: { x: -0.4, y: 1.3, z: -1.4 },
      rotation: { x: 0, y: 0.2, z: 0 },
    },
    dimensions: { width: 1, height: 0.7 },
    tagFilter: ["horse"],
    slideshowMode: "tag",
    slideshowTagIds: ["horse"],
    saveMode: "scale",
    maskEnabled: false,
    admEnabled: true,
    depthIntensity: 1.25,
    mediaPoses: { "albums/beach.jpg": { scale: { width: 1, height: 0.7 } } },
    ...overrides,
  });
}

describe("buildClonePanelPayload", () => {
  it("copies media and persistent settings with a right-side offset", () => {
    const payload = buildClonePanelPayload(sourcePanel());
    expect(payload.media).toEqual({
      directory: "albums",
      selectedId: "albums/beach.jpg",
      sort: "mtime",
      view: "grid",
    });
    expect(payload).toMatchObject({
      locked: false,
      minimized: false,
      maskEnabled: false,
      admEnabled: true,
      depthIntensity: 1.25,
      saveMode: "scale",
      slideshowMode: "tag",
      slideshowTagIds: ["horse"],
      tagFilter: ["horse"],
      dimensions: { width: 1, height: 0.7 },
      restoreDimensions: { width: 1, height: 0.7 },
    });
    expect(payload.transform.position).toMatchObject({
      x: -0.4 + 1 + CLONE_SIDE_GAP,
      y: 1.3,
      z: -1.4,
    });
    expect(payload.transform.rotation).toEqual({ x: 0, y: 0.2, z: 0 });
    expect(payload.mediaPoses).toEqual({
      "albums/beach.jpg": { scale: { width: 1, height: 0.7 } },
    });
  });

  it("deep-copies per-media poses so panels evolve independently", () => {
    const source = sourcePanel();
    const payload = buildClonePanelPayload(source);
    payload.mediaPoses["albums/beach.jpg"].scale.width = 9;
    expect(source.mediaPoses["albums/beach.jpg"].scale.width).toBe(1);
  });

  it("uses restored dimensions when the source is minimized and clears transient flags", () => {
    const payload = buildClonePanelPayload(sourcePanel({
      minimized: true,
      locked: true,
      restoreDimensions: { width: 1.4, height: 0.9 },
    }));
    expect(payload.minimized).toBe(false);
    expect(payload.locked).toBe(false);
    expect(payload.dimensions).toEqual({ width: 1.4, height: 0.9 });
    expect(payload.transform.position.x).toBeCloseTo(-0.4 + 1.4 + CLONE_SIDE_GAP, 10);
  });

  it("normalizes missing media and transform inputs", () => {
    const payload = buildClonePanelPayload(createPanel({ id: "bare" }));
    expect(payload.media).toMatchObject({ directory: null, selectedId: null });
    expect(payload.transform.position.x).toBeCloseTo(0 + 1.2 + CLONE_SIDE_GAP, 10);
    expect(payload.dimensions).toEqual({ width: 1.2, height: 0.8 });
  });
});
