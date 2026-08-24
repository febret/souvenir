import { SORT_MODES, mediaId } from "./media.js";
import { DEFAULT_DISPLAY_MODE, normalizeDisplayMode } from "./media-display.js";
import {
  DEFAULT_ASPECT_RATIO_MODE,
  normalizeAspectRatioMode,
} from "./aspect-ratio.js";
import { normalizeTagIds } from "./tags.js";

export const MINIMIZED_DIMENSIONS = Object.freeze({ width: 0.28, height: 0.18 });
const DEFAULT_DIMENSIONS = Object.freeze({ width: 1.2, height: 0.8 });

const copy = (value) => JSON.parse(JSON.stringify(value));
const numberOr = (value, fallback) => Number.isFinite(value) ? value : fallback;
const vector = (value, fallback) => ({
  x: numberOr(value?.x, fallback.x),
  y: numberOr(value?.y, fallback.y),
  z: numberOr(value?.z, fallback.z),
});
const dimensions = (value, fallback = DEFAULT_DIMENSIONS) => ({
  width: Math.max(0.05, numberOr(value?.width, fallback.width)),
  height: Math.max(0.05, numberOr(value?.height, fallback.height)),
});

export function createPanel({ id, ...overrides } = {}) {
  if (!id) {
    throw new TypeError("A panel id is required.");
  }
  const normalDimensions = dimensions(overrides.restoreDimensions ?? overrides.dimensions);
  const minimized = Boolean(overrides.minimized);
  return {
    id: String(id),
    locked: Boolean(overrides.locked),
    minimized,
    zoomMode: Boolean(overrides.zoomMode),
    maskEnabled: overrides.maskEnabled !== false,
    displayMode: normalizeDisplayMode(overrides.displayMode ?? DEFAULT_DISPLAY_MODE),
    aspectRatioMode: normalizeAspectRatioMode(
      overrides.aspectRatioMode ?? DEFAULT_ASPECT_RATIO_MODE,
    ),
    tagFilter: normalizeTagIds(overrides.tagFilter),
    media: {
      directory: typeof overrides.media?.directory === "string" ? overrides.media.directory : null,
      selectedId: overrides.media?.selectedId == null ? null : String(overrides.media.selectedId),
      sort: Object.values(SORT_MODES).includes(overrides.media?.sort) ? overrides.media.sort : SORT_MODES.NAME,
      view: ["names", "thumbnails", "grid"].includes(overrides.media?.view) ? overrides.media.view : "names",
    },
    transform: {
      position: vector(overrides.transform?.position, { x: 0, y: 0, z: -1 }),
      rotation: vector(overrides.transform?.rotation, { x: 0, y: 0, z: 0 }),
    },
    dimensions: minimized ? { ...MINIMIZED_DIMENSIONS } : normalDimensions,
    restoreDimensions: normalDimensions,
    content: {
      pan: vector(overrides.content?.pan, { x: 0, y: 0, z: 0 }),
      zoom: Math.min(8, Math.max(0.25, numberOr(overrides.content?.zoom, 1))),
    },
    mediaScales: normalizeMediaScales(overrides.mediaScales),
  };
}

/**
 * Per-media panel scale memory. Maps media id -> panel dimensions that were
 * active while that media was displayed, so switching back to an item restores
 * its own panel scale instead of a shared zoom level.
 */
export function normalizeMediaScales(value) {
  const scales = {};
  if (!value || typeof value !== "object") return scales;
  for (const [mediaIdKey, entry] of Object.entries(value)) {
    if (!mediaIdKey) continue;
    const dims = dimensions(entry);
    if (!dims) continue;
    scales[mediaIdKey] = { width: dims.width, height: dims.height };
  }
  return scales;
}

export function restorePanel(serialized, media) {
  const panel = createPanel(serialized);
  const available = Array.isArray(media)
    ? new Map(media.map((item) => [mediaId(item), item]))
    : null;
  if (available && panel.media.selectedId && !available.has(panel.media.selectedId)) {
    panel.media.selectedId = null;
  }
  if (available && panel.media.directory && available.size > 0
    && ![...available.values()].some((item) => item.directory === panel.media.directory)) {
    panel.media.directory = null;
  }
  return panel;
}

export function restorePanels(serializedPanels, media) {
  const seen = new Set();
  return (Array.isArray(serializedPanels) ? serializedPanels : [])
    .filter((panel) => panel && panel.id && !seen.has(String(panel.id)) && seen.add(String(panel.id)))
    .map((panel) => restorePanel(panel, media));
}

export function createPanelStore({ panels = [], focusedId = null, media, idFactory } = {}) {
  let state = {
    panels: restorePanels(panels, media),
    focusedId: null,
  };
  state.focusedId = state.panels.some((panel) => panel.id === focusedId) ? focusedId : state.panels.at(-1)?.id ?? null;
  const subscribers = new Set();
  const makeId = idFactory ?? (() => `panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  function emit() {
    const snapshot = copy(state);
    subscribers.forEach((subscriber) => subscriber(snapshot));
    return snapshot;
  }
  function updatePanel(id, update) {
    const index = state.panels.findIndex((panel) => panel.id === id);
    if (index < 0) return null;
    const next = copy(state.panels[index]);
    update(next);
    state.panels[index] = createPanel(next);
    return state.panels[index];
  }

  return {
    getState: () => copy(state),
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    add(overrides = {}) {
      const panel = createPanel({ ...overrides, id: overrides.id ?? makeId() });
      if (state.panels.some((existing) => existing.id === panel.id)) throw new Error(`Panel "${panel.id}" already exists.`);
      state.panels.push(panel);
      state.focusedId = panel.id;
      emit();
      return copy(panel);
    },
    remove(id) {
      const index = state.panels.findIndex((panel) => panel.id === id);
      if (index < 0) return false;
      state.panels.splice(index, 1);
      if (state.focusedId === id) state.focusedId = state.panels.at(-1)?.id ?? null;
      emit();
      return true;
    },
    focus(id) {
      if (!state.panels.some((panel) => panel.id === id)) return false;
      state.focusedId = id;
      emit();
      return true;
    },
    setMedia(id, selectedId) {
      const panel = updatePanel(id, (item) => {
        // Remember the panel scale currently shown for the outgoing media so it
        // can be restored when that media is shown again.
        if (item.media.selectedId && Number.isFinite(item.dimensions?.width)) {
          item.mediaScales[item.media.selectedId] = {
            width: item.dimensions.width,
            height: item.dimensions.height,
          };
        }
        item.media.selectedId = selectedId == null ? null : String(selectedId);
        const remembered = selectedId == null ? null : item.mediaScales[String(selectedId)];
        if (remembered) {
          item.restoreDimensions = { ...remembered };
          if (!item.minimized) item.dimensions = { ...remembered };
        }
      });
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    setMediaScale(id, mediaKey, nextDimensions) {
      const panel = updatePanel(id, (item) => {
        if (!mediaKey) return;
        const dims = dimensions(nextDimensions, item.restoreDimensions);
        item.mediaScales[String(mediaKey)] = { width: dims.width, height: dims.height };
      });
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    setDirectory(id, directory) {
      const panel = updatePanel(id, (item) => { item.media.directory = directory || null; item.media.selectedId = null; });
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    setSort(id, sort) {
      if (!Object.values(SORT_MODES).includes(sort)) throw new TypeError("Unknown media sort.");
      const panel = updatePanel(id, (item) => { item.media.sort = sort; });
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    setView(id, view) {
      if (!["names", "thumbnails", "grid"].includes(view)) throw new TypeError("Unknown media view.");
      const panel = updatePanel(id, (item) => { item.media.view = view; });
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    setTagFilter(id, tagIds) {
      const nextIds = normalizeTagIds(tagIds);
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      if (current.tagFilter.length === nextIds.length
        && current.tagFilter.every((tagId, index) => tagId === nextIds[index])) {
        return copy(current);
      }
      const panel = updatePanel(id, (item) => { item.tagFilter = nextIds; });
      emit();
      return copy(panel);
    },
    reconcileTagFilters(tagIds) {
      const available = new Set(normalizeTagIds(tagIds));
      let changed = false;
      for (const panel of state.panels) {
        const nextIds = panel.tagFilter.filter((tagId) => available.has(tagId));
        if (nextIds.length !== panel.tagFilter.length) {
          panel.tagFilter = nextIds;
          changed = true;
        }
      }
      return changed ? emit() : copy(state);
    },
    setLocked(id, locked) {
      const panel = updatePanel(id, (item) => { item.locked = Boolean(locked); });
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    setZoomMode(id, zoomMode) {
      const panel = updatePanel(id, (item) => { item.zoomMode = Boolean(zoomMode); });
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    setMaskEnabled(id, maskEnabled) {
      const panel = updatePanel(id, (item) => { item.maskEnabled = Boolean(maskEnabled); });
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    setDisplayMode(id, displayMode) {
      const panel = updatePanel(id, (item) => {
        item.displayMode = normalizeDisplayMode(displayMode);
      });
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    setAspectRatioMode(id, aspectRatioMode) {
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      const nextMode = normalizeAspectRatioMode(aspectRatioMode);
      if (current.aspectRatioMode === nextMode) return copy(current);
      const panel = updatePanel(id, (item) => {
        item.aspectRatioMode = nextMode;
      });
      emit();
      return copy(panel);
    },
    setTransform(id, transform) {
      const panel = updatePanel(id, (item) => {
        item.transform = {
          position: vector(transform?.position, item.transform.position),
          rotation: vector(transform?.rotation, item.transform.rotation),
        };
      });
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    setDimensions(id, nextDimensions) {
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      const next = dimensions(nextDimensions, current.restoreDimensions);
      const restoreUnchanged =
        next.width === current.restoreDimensions.width &&
        next.height === current.restoreDimensions.height;
      const visibleUnchanged = current.minimized ||
        (next.width === current.dimensions.width && next.height === current.dimensions.height);
      if (restoreUnchanged && visibleUnchanged) return copy(current);
      const panel = updatePanel(id, (item) => {
        item.restoreDimensions = next;
        if (!item.minimized) item.dimensions = next;
        // Track the panel scale per displayed media instead of a shared
        // content-zoom level.
        if (item.media.selectedId) {
          item.mediaScales[item.media.selectedId] = { width: next.width, height: next.height };
        }
      });
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    setContentPan(id, pan) {
      const panel = updatePanel(id, (item) => {
        item.content.pan = vector(pan, item.content.pan);
      });
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    setContentZoom(id, zoom) {
      const panel = updatePanel(id, (item) => {
        item.content.zoom = Math.min(8, Math.max(0.25, numberOr(zoom, item.content.zoom)));
      });
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    minimize(id) {
      const panel = updatePanel(id, (item) => {
        if (!item.minimized) {
          item.restoreDimensions = dimensions(item.dimensions);
          item.minimized = true;
          item.dimensions = { ...MINIMIZED_DIMENSIONS };
        }
      });
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    restore(id) {
      const panel = updatePanel(id, (item) => {
        if (item.minimized) {
          item.minimized = false;
          item.dimensions = dimensions(item.restoreDimensions);
        }
      });
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    update(id, callback) {
      const panel = updatePanel(id, callback);
      if (!panel) return null;
      emit();
      return copy(panel);
    },
    restoreFrom(serialized) {
      state = {
        panels: restorePanels(serialized?.panels, media),
        focusedId: null,
      };
      state.focusedId = state.panels.some((panel) => panel.id === serialized?.focusedId)
        ? serialized.focusedId : state.panels.at(-1)?.id ?? null;
      return emit();
    },
  };
}
