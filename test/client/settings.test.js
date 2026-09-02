import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  reconcileSelectedDirectories,
} from "../../app/src/core/settings.js";

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

});
