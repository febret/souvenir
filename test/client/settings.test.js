import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  normalizePowerOfTwoResolution,
  reconcileSelectedDirectories,
  saveSettings,
  validateSettings,
} from "../../app/src/core/settings.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("settings", () => {
  it("uses versioned defaults and reconciles saved directory choices", () => {
    expect(DEFAULT_SETTINGS.version).toBe(SETTINGS_VERSION);
    expect(reconcileSelectedDirectories({
      mediaDirectories: [" albums ", "albums", "", "missing"],
      autoplayVideos: true,
      slideshowIntervalMs: 50,
    }, new Set(["albums"]))).toEqual({
      version: SETTINGS_VERSION,
      mediaDirectories: ["albums"],
      autoplayVideos: true,
      slideshowIntervalMs: 1000,
      tagSortOrder: DEFAULT_SETTINGS.tagSortOrder,
      captionSize: DEFAULT_SETTINGS.captionSize,
      captionTransparency: DEFAULT_SETTINGS.captionTransparency,
      captionDistance: DEFAULT_SETTINGS.captionDistance,
      admDefaultDepthIntensity: DEFAULT_SETTINGS.admDefaultDepthIntensity,
      admMaxResolution: DEFAULT_SETTINGS.admMaxResolution,
    });
  });

  it("reports invalid values without trusting them", () => {
    const result = validateSettings({
      autoplayVideos: "yes",
      slideshowIntervalMs: Infinity,
      captionDistance: 10,
      admDefaultDepthIntensity: -1,
      admMaxResolution: 4096,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(5);
    expect(result.value.autoplayVideos).toBe(DEFAULT_SETTINGS.autoplayVideos);
    expect(result.value.admMaxResolution).toBe(2048);
  });

  it("normalizes to a valid power-of-two resolution", () => {
    expect(normalizePowerOfTwoResolution(768)).toBe(1024);
    expect(normalizePowerOfTwoResolution(1536)).toBe(2048);
    expect(normalizePowerOfTwoResolution(1234)).toBe(1024);
  });

  it("persists valid settings and safely falls back from corrupt values", () => {
    const storage = memoryStorage();
    const saved = saveSettings(storage, { ...DEFAULT_SETTINGS, mediaDirectories: ["photos"], autoplayVideos: true });
    expect(saved.mediaDirectories).toEqual(["photos"]);
    expect(loadSettings(storage)).toEqual(saved);

    storage.setItem(SETTINGS_STORAGE_KEY, "{broken");
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });
});
