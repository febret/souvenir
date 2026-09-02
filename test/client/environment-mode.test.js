import { describe, expect, it } from "vitest";

import {
  DEFAULT_ENVIRONMENT_MODE,
  ENVIRONMENT_MODES,
} from "../../app/src/core/environment-mode.js";
import {
  LAYOUT_STORAGE_KEY,
  loadLayout,
  saveLayout,
} from "../../app/src/scene/layout-storage.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe("environment modes", () => {
  it("persists the selected mode and defaults or normalizes layout values", () => {
    const storage = memoryStorage();
    expect(loadLayout(storage, "library-a")).toEqual({
      panels: [],
      focusedId: null,
      runtime: {},
      environmentMode: DEFAULT_ENVIRONMENT_MODE,
      libraryId: "library-a",
    });

    saveLayout(
      storage,
      { panels: [{ id: "panel-1" }], focusedId: "panel-1" },
      new Map([["panel-1", { playlist: [{ path: "beach.jpg" }], slideshow: { active: true } }]]),
      "library-a",
      ENVIRONMENT_MODES.UNDERWATER,
    );
    expect(JSON.parse(storage.getItem(LAYOUT_STORAGE_KEY))).toMatchObject({
      environmentMode: ENVIRONMENT_MODES.UNDERWATER,
    });
    expect(loadLayout(storage, "library-a").environmentMode).toBe(ENVIRONMENT_MODES.UNDERWATER);

    saveLayout(storage, { panels: [], focusedId: null }, new Map(), "library-a", "purple");
    expect(loadLayout(storage, "library-a").environmentMode).toBe(DEFAULT_ENVIRONMENT_MODE);

    storage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        panels: [],
        focusedId: null,
        runtime: {},
        environmentMode: "purple",
        libraryId: "library-a",
      }),
    );
    expect(loadLayout(storage, "library-a").environmentMode).toBe(DEFAULT_ENVIRONMENT_MODE);
  });
});
