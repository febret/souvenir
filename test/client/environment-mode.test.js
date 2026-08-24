import { describe, expect, it } from "vitest";

import {
  DEFAULT_ENVIRONMENT_MODE,
  ENVIRONMENT_MODE_CONFIG,
  ENVIRONMENT_MODE_DESCRIPTORS,
  ENVIRONMENT_MODE_LABELS,
  ENVIRONMENT_MODES,
  normalizeEnvironmentMode,
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
  it("exports the exact chooser modes, labels, default, and effect configs", () => {
    expect(ENVIRONMENT_MODES).toEqual({
      NORMAL: "normal",
      DARK: "dark",
      NIGHT: "night",
      UNDERWATER: "underwater",
      RED: "red",
    });
    expect(DEFAULT_ENVIRONMENT_MODE).toBe("normal");
    expect(ENVIRONMENT_MODE_LABELS).toEqual({
      normal: "Normal",
      dark: "Dark",
      night: "Night",
      underwater: "Underwater",
      red: "Red",
    });
    expect(ENVIRONMENT_MODE_CONFIG).toEqual({
      normal: { color: 0x000000, opacity: 0 },
      dark: { color: 0x000000, opacity: 0.6 },
      night: { color: 0x07162f, opacity: 0.9 },
      underwater: {
        color: 0x087eaa,
        opacity: 0.8,
        accentColor: 0x42d9e8,
        animated: true,
      },
      red: { color: 0x75070c, opacity: 0.8 },
    });
    expect(ENVIRONMENT_MODE_DESCRIPTORS).toEqual([
      { mode: "normal", label: "Normal", color: 0x000000, opacity: 0 },
      { mode: "dark", label: "Dark", color: 0x000000, opacity: 0.6 },
      { mode: "night", label: "Night", color: 0x07162f, opacity: 0.9 },
      {
        mode: "underwater",
        label: "Underwater",
        color: 0x087eaa,
        opacity: 0.8,
        accentColor: 0x42d9e8,
        animated: true,
      },
      { mode: "red", label: "Red", color: 0x75070c, opacity: 0.8 },
    ]);
  });

  it("normalizes unknown persisted values to Normal", () => {
    for (const value of [undefined, null, "", "Dark", " purple ", {}, 4]) {
      expect(normalizeEnvironmentMode(value)).toBe(DEFAULT_ENVIRONMENT_MODE);
    }
    for (const mode of Object.values(ENVIRONMENT_MODES)) {
      expect(normalizeEnvironmentMode(mode)).toBe(mode);
    }
  });

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
