// Pure per-control enable/active state for the options panel.

const LIGHTING_ACTION_PREFIXES = [
  "set-light-direction:",
  "set-light-color:",
  "set-ambient-color:",
  "set-ambient-intensity:",
];

function isLightingControl(action) {
  return action === "toggle-light-fx"
    || LIGHTING_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix));
}

function computeActive(action, state) {
  const {
    maskEnabled,
    maskAvailable,
    admEnabled,
    softDepthEnabled,
    fadeDepthEnabled,
    focusBlurEnabled,
    lightFxEnabled,
    lightDirection,
    lightColor,
    ambientColor,
    ambientIntensity,
  } = state;
  if (action === "toggle-mask") return Boolean(maskEnabled && maskAvailable);
  if (action === "toggle-3d-mode") return Boolean(admEnabled);
  if (action === "toggle-soft-depth") return Boolean(softDepthEnabled);
  if (action === "toggle-fade-depth") return Boolean(fadeDepthEnabled);
  if (action === "toggle-focus-blur") return Boolean(focusBlurEnabled);
  if (action === "toggle-light-fx") return Boolean(lightFxEnabled);
  const [, value] = action.split(":");
  if (action.startsWith("set-light-direction:")) return value === lightDirection;
  if (action.startsWith("set-light-color:")) return value === lightColor;
  if (action.startsWith("set-ambient-color:")) return value === ambientColor;
  if (action.startsWith("set-ambient-intensity:")) {
    return Math.round(Number(value) * 100) === Math.round((ambientIntensity ?? 0.5) * 100);
  }
  return false;
}

function computeInactive(action, state) {
  const { mediaType, mediaLoaded, lightingActive } = state;
  return (action === "toggle-mask" && !state.maskAvailable)
    || (action === "edit-erase-mask" && !mediaLoaded)
    || (action === "toggle-3d-mode" && mediaType !== "image")
    || (action === "delete-depth-mask" && (mediaType !== "image" || !mediaLoaded))
    || ((action === "toggle-soft-depth" || action === "toggle-fade-depth" || action === "toggle-focus-blur")
      && (mediaType !== "image" || !mediaLoaded))
    || (isLightingControl(action) && !lightingActive)
    || state.admPromptVisible;
}

/**
 * Applies visual active/inactive tinting to every control in `content`.
 */
export function applyControlStates(content, {
  maskAvailable,
  mediaLoaded,
  mediaType,
  maskEnabled,
  admEnabled,
  admPromptVisible,
  softDepthEnabled,
  fadeDepthEnabled,
  focusBlurEnabled,
  lightFxEnabled,
  lightDirection,
  lightColor,
  ambientColor,
  ambientIntensity,
  depthAvailable,
}) {
  const state = {
    maskAvailable,
    mediaLoaded,
    mediaType,
    maskEnabled,
    admEnabled,
    admPromptVisible,
    softDepthEnabled,
    fadeDepthEnabled,
    focusBlurEnabled,
    lightFxEnabled,
    lightDirection,
    lightColor,
    ambientColor,
    ambientIntensity,
    depthAvailable,
    lightingActive: admEnabled && mediaType === "image" && mediaLoaded && !admPromptVisible,
  };
  for (const control of content.children) {
    const action = control.userData?.action;
    if (!action) continue;
    const inactive = computeInactive(action, state);
    const active = computeActive(action, state);
    const isSwatch = Boolean(control.userData?.colorSwatch);
    control.material.color.set(inactive ? 0x5f6b67 : (active && !isSwatch) ? 0xaaf1c3 : 0xffffff);
  }
}
