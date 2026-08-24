import { DEFAULT_ENVIRONMENT_MODE, normalizeEnvironmentMode } from "../core/environment-mode.js";

export const LAYOUT_STORAGE_KEY = "souvenir.layout.v1";

function emptyLayout(libraryId) {
  return {
    panels: [],
    focusedId: null,
    runtime: {},
    environmentMode: DEFAULT_ENVIRONMENT_MODE,
    libraryId,
  };
}

export function validateLibraryId(libraryId) {
  if (typeof libraryId !== "string" || !libraryId.trim()) {
    throw new TypeError("A nonempty library ID is required.");
  }
  return libraryId;
}

export function loadLayout(storage, currentLibraryId) {
  const libraryId = validateLibraryId(currentLibraryId);
  const raw = storage.getItem(LAYOUT_STORAGE_KEY);
  if (!raw) {
    return emptyLayout(libraryId);
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new TypeError("The saved spatial layout is invalid.");
  }
  if (
    typeof parsed.libraryId !== "string" ||
    !parsed.libraryId.trim() ||
    parsed.libraryId !== libraryId
  ) {
    return emptyLayout(libraryId);
  }
  if (!Array.isArray(parsed.panels)) {
    throw new TypeError("The saved spatial layout is invalid.");
  }
  return {
    panels: parsed.panels,
    focusedId: typeof parsed.focusedId === "string" ? parsed.focusedId : null,
    runtime: parsed.runtime && typeof parsed.runtime === "object" ? parsed.runtime : {},
    environmentMode: normalizeEnvironmentMode(parsed.environmentMode),
    libraryId,
  };
}

export function saveLayout(
  storage,
  state,
  runtime,
  currentLibraryId,
  environmentMode = DEFAULT_ENVIRONMENT_MODE,
) {
  const libraryId = validateLibraryId(currentLibraryId);
  const serializedRuntime = {};
  for (const [panelId, value] of runtime) {
    serializedRuntime[panelId] = {
      playlist: value.playlist ?? [],
      slideshow: value.slideshow ?? null,
    };
  }
  storage.setItem(
    LAYOUT_STORAGE_KEY,
    JSON.stringify({
      panels: state.panels,
      focusedId: state.focusedId,
      runtime: serializedRuntime,
      environmentMode: normalizeEnvironmentMode(environmentMode),
      libraryId,
    }),
  );
}
