import { describe, expect, it } from "vitest";
import { computePanelControlState } from "../../app/src/scene/panel-options/control-states.js";

const BASE_STATE = {
  maskAvailable: true,
  mediaLoaded: true,
  mediaType: "image",
  maskEnabled: true,
  admEnabled: true,
  admPromptVisible: false,
  softDepthEnabled: false,
  fadeDepthEnabled: false,
  focusBlurEnabled: false,
  lightFxEnabled: false,
  lightDirection: "front",
  lightColor: "white",
  ambientColor: "white",
  ambientIntensity: 0.5,
  depthAvailable: true,
  lightingActive: true,
};

describe("panel options control states", () => {
  it("activates toggles only when their feature is on", () => {
    expect(computePanelControlState("toggle-mask", { ...BASE_STATE, maskEnabled: true }))
      .toEqual({ active: true, inactive: false });
    expect(computePanelControlState("toggle-mask", { ...BASE_STATE, maskEnabled: false }))
      .toEqual({ active: false, inactive: false });
    expect(computePanelControlState("toggle-3d-mode", { ...BASE_STATE, admEnabled: true }))
      .toEqual({ active: true, inactive: false });
    expect(computePanelControlState("toggle-light-fx", { ...BASE_STATE, lightFxEnabled: true }))
      .toEqual({ active: true, inactive: false });
  });

  it("disables mask controls that have no active mask", () => {
    expect(computePanelControlState("toggle-mask", { ...BASE_STATE, maskAvailable: false }))
      .toEqual({ active: false, inactive: true });
  });

  it("keeps erase/3D-mode off when no image is loaded", () => {
    const video = { ...BASE_STATE, mediaType: "video" };
    expect(computePanelControlState("edit-erase-mask", { ...BASE_STATE, mediaLoaded: false }))
      .toMatchObject({ inactive: true });
    expect(computePanelControlState("toggle-3d-mode", video)).toMatchObject({ inactive: true });
    expect(computePanelControlState("delete-depth-mask", video)).toMatchObject({ inactive: true });
    for (const toggle of ["toggle-soft-depth", "toggle-fade-depth", "toggle-focus-blur"]) {
      expect(computePanelControlState(toggle, video)).toMatchObject({ inactive: true });
    }
  });

  it("gates lighting controls behind a loaded ADM image", () => {
    const noLighting = { ...BASE_STATE, admEnabled: false, lightingActive: false };
    for (const action of [
      "toggle-light-fx",
      "set-light-direction:top",
      "set-light-color:warm",
      "set-ambient-color:cool",
      "set-ambient-intensity:0.75",
    ]) {
      expect(computePanelControlState(action, noLighting)).toMatchObject({ inactive: true });
    }
    expect(computePanelControlState("set-light-direction:top", BASE_STATE))
      .toEqual({ active: false, inactive: false });
  });

  it("marks the selected direction, color, and intensity", () => {
    expect(computePanelControlState("set-light-direction:front", BASE_STATE)).toEqual({ active: true, inactive: false });
    expect(computePanelControlState("set-light-color:white", BASE_STATE)).toEqual({ active: true, inactive: false });
    expect(computePanelControlState("set-ambient-color:white", BASE_STATE)).toEqual({ active: true, inactive: false });
    expect(computePanelControlState("set-ambient-intensity:0.5", BASE_STATE)).toEqual({ active: true, inactive: false });
    expect(computePanelControlState("set-ambient-intensity:0.25", BASE_STATE)).toEqual({ active: false, inactive: false });
  });

  it("leaves save-mode buttons to build-time highlighting, not runtime state", () => {
    expect(computePanelControlState("set-save-mode:scale", BASE_STATE)).toEqual({ active: false, inactive: false });
  });

  it("marks the active slideshow mode", () => {
    expect(computePanelControlState("set-slideshow-mode:tag", { ...BASE_STATE, slideshowMode: "tag" }))
      .toEqual({ active: true, inactive: false });
    expect(computePanelControlState("set-slideshow-mode:normal", { ...BASE_STATE, slideshowMode: "tag" }))
      .toEqual({ active: false, inactive: false });
  });

  it("disables every control while the ADM prompt is visible", () => {
    for (const action of ["toggle-mask", "edit-erase-mask", "toggle-light-fx", "set-save-mode:full"]) {
      expect(computePanelControlState(action, { ...BASE_STATE, admPromptVisible: true }))
        .toMatchObject({ inactive: true });
    }
  });
});