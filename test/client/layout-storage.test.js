import { describe, expect, it } from "vitest";

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

function blankLayout(libraryId) {
  return {
    panels: [],
    focusedId: null,
    runtime: {},
    environmentMode: "normal",
    libraryId,
  };
}

describe("layout storage library reconciliation", () => {
  it("restores panels, media runtime, environment, and mask settings for the same library", () => {
    const storage = memoryStorage();
    const state = {
      panels: [{
        id: "panel-1",
        maskEnabled: false,
        media: { directory: "photos", selectedId: "photos/sun.jpg" },
      }],
      focusedId: "panel-1",
    };
    const runtime = new Map([[
      "panel-1",
      { playlist: [{ path: "photos/sun.jpg" }], slideshow: { active: true } },
    ]]);

    saveLayout(storage, state, runtime, "library-a", "underwater");

    expect(loadLayout(storage, "library-a")).toEqual({
      ...state,
      runtime: {
        "panel-1": {
          playlist: [{ path: "photos/sun.jpg" }],
          slideshow: { active: true },
        },
      },
      environmentMode: "underwater",
      libraryId: "library-a",
    });
  });

  it("starts empty when the persisted layout belongs to a different library", () => {
    const storage = memoryStorage();
    saveLayout(
      storage,
      { panels: [{ id: "old-panel" }], focusedId: "old-panel" },
      new Map([["old-panel", { playlist: [{ path: "old.jpg" }] }]]),
      "library-a",
      "night",
    );

    expect(loadLayout(storage, "library-b")).toEqual(blankLayout("library-b"));
  });

  it("treats malformed persisted IDs as untrusted and requires a valid current ID", () => {
    const storage = memoryStorage();
    storage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ panels: [{ id: "old-panel" }], libraryId: "   " }),
    );

    expect(loadLayout(storage, "library-a")).toEqual(blankLayout("library-a"));
    expect(() => loadLayout(storage, "")).toThrow("nonempty library ID");
    expect(() =>
      saveLayout(storage, { panels: [], focusedId: null }, new Map(), null),
    ).toThrow("nonempty library ID");
  });

  it("persists the current library ID with each saved layout", () => {
    const storage = memoryStorage();

    saveLayout(storage, { panels: [], focusedId: null }, new Map(), "library-a");

    expect(JSON.parse(storage.getItem(LAYOUT_STORAGE_KEY))).toMatchObject({
      libraryId: "library-a",
    });
  });
});
