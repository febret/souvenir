// Pure signature computation for PanelOptionsView rebuild decisions.

/**
 * Builds a comparable snapshot of everything the options view renders.
 * Returns null-equivalent stability via string equality at the call site.
 */
export function computeSignature({
  saveMode,
  tagDefinitions,
  mediaTagIds,
  tagListExpanded,
  admSettings,
}) {
  const settings = admSettings ?? {};
  return JSON.stringify({
    saveMode,
    tagListExpanded: Boolean(tagListExpanded),
    tags: (Array.isArray(tagDefinitions) ? tagDefinitions : []).map((t) => [t.id, t.name]),
    selected: Array.isArray(mediaTagIds) ? mediaTagIds : [],
    adm: {
      softDepthEnabled: Boolean(settings.softDepthEnabled),
      fadeDepthEnabled: Boolean(settings.fadeDepthEnabled),
      focusBlurEnabled: Boolean(settings.focusBlurEnabled),
      focusPosition: String(settings.focusPosition ?? "middle"),
      focusStrength: String(settings.focusStrength ?? "middle"),
      lightFxEnabled: Boolean(settings.lightFxEnabled),
      lightDirection: String(settings.lightDirection ?? "front"),
      lightColor: String(settings.lightColor ?? "white"),
      ambientColor: String(settings.ambientColor ?? "white"),
      ambientIntensity: Number(settings.ambientIntensity ?? 0.5),
    },
  });
}
