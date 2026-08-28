import { describe, expect, it, vi } from "vitest";

import { applyControlStates } from "../../app/src/scene/panel-options/control-states.js";

function runStateForAction(action, stateOverrides = {}) {
  const setColor = vi.fn();
  const content = {
    children: [{
      userData: { action },
      material: { color: { set: setColor } },
    }],
  };
  applyControlStates(content, {
    maskAvailable: true,
    mediaLoaded: true,
    mediaType: "image",
    maskEnabled: true,
    admEnabled: false,
    admPromptVisible: false,
    softDepthEnabled: false,
    fadeDepthEnabled: false,
    focusBlurEnabled: false,
    lightFxEnabled: false,
    lightDirection: "front",
    lightColor: "white",
    ambientColor: "white",
    ambientIntensity: 0.5,
    depthAvailable: false,
    ...stateOverrides,
  });
  return setColor;
}

describe("panel options control states", () => {
  it("keeps delete-depth active for loaded images even before depth is loaded", () => {
    const setColor = runStateForAction("delete-depth-mask", { depthAvailable: false });
    expect(setColor).toHaveBeenCalledWith(0xffffff);
  });

  it("disables delete-depth for non-image media", () => {
    const setColor = runStateForAction("delete-depth-mask", { mediaType: "video" });
    expect(setColor).toHaveBeenCalledWith(0x5f6b67);
  });
});
