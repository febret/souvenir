import { SORT_MODES, mediaId } from "./media.js";
import { normalizeTagIds } from "./tags.js";

export const SAVE_MODES = Object.freeze(["disabled", "scale", "full"]);
export const DEFAULT_SAVE_MODE = "scale";

/**
 * Fixed outline palette. Panels are identified by number and color; color is
 * derived from the panel's creation order.
 */
export const PANEL_COLORS = Object.freeze([
  "#9be7b5",
  "#8ec9ff",
  "#ffd28e",
  "#f2a2c0",
  "#c9b3ff",
  "#a7f0dc",
  "#ffe08a",
  "#b6e39a",
]);

export function panelColor(index) {
  const resolved = Number.isInteger(index) && index >= 0 ? index : 0;
  return PANEL_COLORS[resolved % PANEL_COLORS.length];
}

const DEFAULT_DIMENSIONS = Object.freeze({ width: 1.2, height: 0.8 });
const MINIMIZED_DIMENSIONS = Object.freeze({ width: 0.28, height: 0.18 });
const DEFAULT_DEPTH_INTENSITY = 0.35;

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
const depthIntensity = (value) => Math.min(3, Math.max(0, numberOr(value, DEFAULT_DEPTH_INTENSITY)));

export function normalizeSaveMode(mode) {
  return SAVE_MODES.includes(mode) ? mode : DEFAULT_SAVE_MODE;
}

/**
 * Builds a normalized per-media saved pose entry.
 *
 * `scale` entries persist only dimensions; `full` entries also persist the
 * panel position and orientation.
 */
function mediaPose(entry, saveMode) {
  if (!entry || typeof entry !== "object") return null;
  const dims = dimensions(entry.dimensions ?? entry.scale ?? entry);
  const pose = { scale: { width: dims.width, height: dims.height } };
  if (saveMode === "full" && entry.transform) {
    pose.transform = {
      position: vector(entry.transform.position, { x: 0, y: 0, z: -1 }),
      rotation: vector(entry.transform.rotation, { x: 0, y: 0, z: 0 }),
    };
  }
  return pose;
}

export function createPanel({ id, ...overrides } = {}) {
  if (!id) {
    throw new TypeError("A panel id is required.");
  }
  const saveMode = normalizeSaveMode(overrides.saveMode);
  const minimized = Boolean(overrides.minimized);
  const panelDimensions = dimensions(overrides.dimensions);
  return {
    id: String(id),
    locked: Boolean(overrides.locked),
    minimized,
    maskEnabled: overrides.maskEnabled !== false,
    admEnabled: Boolean(overrides.admEnabled),
    depthIntensity: depthIntensity(overrides.depthIntensity),
    saveMode,
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
    dimensions: minimized ? dimensions(overrides.dimensions, MINIMIZED_DIMENSIONS) : panelDimensions,
    restoreDimensions: dimensions(
      overrides.restoreDimensions,
      minimized ? panelDimensions : panelDimensions,
    ),
    // Per-media saved poses keyed by media id. Legacy `mediaScales` maps are
    // migrated into scale-only entries. Disabled save mode never keeps poses.
    mediaPoses: saveMode === "disabled"
      ? {}
      : normalizeMediaPoses(overrides.mediaPoses ?? migrateMediaScales(overrides.mediaScales), saveMode),
  };
}

/**
 * Migrates a legacy `mediaScales` map ({mediaId: {width,height}}) into the
 * saved-pose shape.
 */
function migrateMediaScales(value) {
  if (!value || typeof value !== "object") return undefined;
  const migrated = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key || !entry || typeof entry !== "object") continue;
    migrated[key] = { dimensions: entry };
  }
  return migrated;
}

/**
 * Normalizes a per-media saved-pose map. Entries whose transform is missing
 * are kept as scale-only regardless of the requested save mode.
 */
export function normalizeMediaPoses(value, saveMode = DEFAULT_SAVE_MODE) {
  const poses = {};
  if (!value || typeof value !== "object") return poses;
  for (const [mediaIdKey, entry] of Object.entries(value)) {
    if (!mediaIdKey) continue;
    const pose = mediaPose(entry, saveMode === "full" ? "full" : "scale");
    if (pose) poses[mediaIdKey] = pose;
  }
  return poses;
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

  function emit(change = { type: "reset", panelIds: [] }) {
    const snapshot = copy(state);
    subscribers.forEach((subscriber) => subscriber(snapshot, change));
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
      emit({ type: "structure", panelIds: [panel.id], focusChanged: true });
      return copy(panel);
    },
    remove(id) {
      const index = state.panels.findIndex((panel) => panel.id === id);
      if (index < 0) return false;
      const focusChanged = state.focusedId === id;
      state.panels.splice(index, 1);
      if (focusChanged) state.focusedId = state.panels.at(-1)?.id ?? null;
      emit({ type: "structure", panelIds: [id], focusChanged });
      return true;
    },
    focus(id) {
      if (!state.panels.some((panel) => panel.id === id)) return false;
      if (state.focusedId === id) return true;
      const previousFocusedId = state.focusedId;
      state.focusedId = id;
      emit({
        type: "focus",
        panelIds: [previousFocusedId, id].filter(Boolean),
        focusChanged: true,
      });
      return true;
    },
    setMedia(id, selectedId) {
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      const nextSelectedId = selectedId == null ? null : String(selectedId);
      if (current.media.selectedId === nextSelectedId) return copy(current);
      const panel = updatePanel(id, (item) => {
        // Remember the outgoing media's saved pose so it can be restored when
        // that media is shown again.
        if (item.media.selectedId && item.saveMode !== "disabled") {
          const pose = mediaPose({
            dimensions: item.dimensions,
            transform: item.saveMode === "full" ? item.transform : null,
          }, item.saveMode);
          if (pose) item.mediaPoses[item.media.selectedId] = pose;
        }
        item.media.selectedId = nextSelectedId;
        // Restore the incoming media's saved pose when save mode allows.
        if (selectedId != null && item.saveMode !== "disabled") {
          const remembered = item.mediaPoses[String(selectedId)];
          if (remembered?.scale) item.dimensions = { ...remembered.scale };
          if (remembered?.transform) item.transform = copy(remembered.transform);
        }
      });
      if (!panel) return null;
      emit({ type: "panel", panelIds: [id] });
      return copy(panel);
    },
    setMediaContext(id, { directory, sort, view, selectedId } = {}) {
      if (sort != null && !Object.values(SORT_MODES).includes(sort)) {
        throw new TypeError("Unknown media sort.");
      }
      if (view != null && !["names", "thumbnails", "grid"].includes(view)) {
        throw new TypeError("Unknown media view.");
      }
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      const nextDirectory = directory || null;
      const nextSelectedId = selectedId == null ? null : String(selectedId);
      if (current.media.directory === nextDirectory
        && current.media.sort === (sort ?? current.media.sort)
        && current.media.view === (view ?? current.media.view)
        && current.media.selectedId === nextSelectedId) {
        return copy(current);
      }
      const panel = updatePanel(id, (item) => {
        if (item.media.selectedId && item.media.selectedId !== nextSelectedId
          && item.saveMode !== "disabled") {
          const pose = mediaPose({
            dimensions: item.dimensions,
            transform: item.saveMode === "full" ? item.transform : null,
          }, item.saveMode);
          if (pose) item.mediaPoses[item.media.selectedId] = pose;
        }
        item.media.directory = nextDirectory;
        if (sort != null) item.media.sort = sort;
        if (view != null) item.media.view = view;
        item.media.selectedId = nextSelectedId;
        if (nextSelectedId && item.saveMode !== "disabled") {
          const remembered = item.mediaPoses[nextSelectedId];
          if (remembered?.scale) item.dimensions = { ...remembered.scale };
          if (remembered?.transform) item.transform = copy(remembered.transform);
        }
      });
      emit({ type: "panel", panelIds: [id] });
      return copy(panel);
    },
    setMediaPose(id, mediaKey, pose) {
      const panel = updatePanel(id, (item) => {
        if (!mediaKey || item.saveMode === "disabled") return;
        const normalized = mediaPose(pose, item.saveMode);
        if (normalized) item.mediaPoses[String(mediaKey)] = normalized;
      });
      if (!panel) return null;
      emit({ type: "panel", panelIds: [id] });
      return copy(panel);
    },
    setSaveMode(id, mode) {
      const nextMode = normalizeSaveMode(mode);
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      if (current.saveMode === nextMode) return copy(current);
      const panel = updatePanel(id, (item) => {
        item.saveMode = nextMode;
        // Downgrading to disabled drops per-media poses; upgrading re-records
        // the current media's pose immediately.
        if (nextMode === "disabled") {
          item.mediaPoses = {};
        } else if (item.media.selectedId) {
          const pose = mediaPose({
            dimensions: item.dimensions,
            transform: nextMode === "full" ? item.transform : null,
          }, nextMode);
          if (pose) item.mediaPoses[item.media.selectedId] = pose;
        }
      });
      if (!panel) return null;
      emit({ type: "panel", panelIds: [id] });
      return copy(panel);
    },
    setLocked(id, locked) {
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      if (current.locked === Boolean(locked)) return copy(current);
      const panel = updatePanel(id, (item) => { item.locked = Boolean(locked); });
      emit({ type: "panel", panelIds: [id] });
      return copy(panel);
    },
    minimize(id) {
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      if (current.minimized) return copy(current);
      const panel = updatePanel(id, (item) => {
        item.restoreDimensions = { ...item.dimensions };
        item.dimensions = { ...MINIMIZED_DIMENSIONS };
        item.minimized = true;
      });
      emit({ type: "panel", panelIds: [id] });
      return copy(panel);
    },
    restore(id) {
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      if (!current.minimized) return copy(current);
      const panel = updatePanel(id, (item) => {
        item.dimensions = dimensions(item.restoreDimensions);
        item.minimized = false;
      });
      emit({ type: "panel", panelIds: [id] });
      return copy(panel);
    },
    setMaskEnabled(id, maskEnabled) {
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      if (current.maskEnabled === Boolean(maskEnabled)) return copy(current);
      const panel = updatePanel(id, (item) => { item.maskEnabled = Boolean(maskEnabled); });
      emit({ type: "panel", panelIds: [id] });
      return copy(panel);
    },
    setAdmEnabled(id, enabled) {
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      if (current.admEnabled === Boolean(enabled)) return copy(current);
      const panel = updatePanel(id, (item) => { item.admEnabled = Boolean(enabled); });
      emit({ type: "panel", panelIds: [id] });
      return copy(panel);
    },
    setDepthIntensity(id, value) {
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      const next = depthIntensity(value);
      if (current.depthIntensity === next) return copy(current);
      const panel = updatePanel(id, (item) => { item.depthIntensity = next; });
      emit({ type: "panel", panelIds: [id] });
      return copy(panel);
    },
    setTransform(id, transform) {
      return this.setPose(id, { transform });
    },
    setPose(id, { transform, dimensions: nextDimensions } = {}) {
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      const nextTransform = transform
        ? {
          position: vector(transform.position, current.transform.position),
          rotation: vector(transform.rotation, current.transform.rotation),
        }
        : current.transform;
      const nextDimensionsValue = nextDimensions
        ? dimensions(nextDimensions, current.dimensions)
        : current.dimensions;
      const transformChanged = ["x", "y", "z"].some((axis) =>
        nextTransform.position[axis] !== current.transform.position[axis]
        || nextTransform.rotation[axis] !== current.transform.rotation[axis]);
      const dimensionsChanged = nextDimensionsValue.width !== current.dimensions.width
        || nextDimensionsValue.height !== current.dimensions.height;
      if (!transformChanged && !dimensionsChanged) return copy(current);
      const panel = updatePanel(id, (item) => {
        item.transform = nextTransform;
        item.dimensions = nextDimensionsValue;
        // Keep the displayed media's full pose up to date while saving fully.
        if (item.saveMode !== "disabled" && item.media.selectedId) {
          const pose = mediaPose({
            dimensions: item.dimensions,
            transform: item.saveMode === "full" ? item.transform : null,
          }, item.saveMode);
          if (pose) item.mediaPoses[item.media.selectedId] = pose;
        }
      });
      emit({ type: "panel", panelIds: [id] });
      return copy(panel);
    },
    setDimensions(id, nextDimensions) {
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      const next = dimensions(nextDimensions, current.dimensions);
      if (next.width === current.dimensions.width && next.height === current.dimensions.height) {
        return copy(current);
      }
      const panel = updatePanel(id, (item) => {
        item.dimensions = next;
        // Track the panel scale for the displayed media while saving scale or
        // fully.
        if (item.saveMode !== "disabled" && item.media.selectedId) {
          const pose = mediaPose({
            dimensions: next,
            transform: item.saveMode === "full" ? item.transform : null,
          }, item.saveMode);
          if (pose) item.mediaPoses[item.media.selectedId] = pose;
        }
      });
      if (!panel) return null;
      emit({ type: "panel", panelIds: [id] });
      return copy(panel);
    },
    setDirectory(id, directory) {
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      const next = directory || null;
      if (current.media.directory === next && current.media.selectedId == null) return copy(current);
      const panel = updatePanel(id, (item) => { item.media.directory = next; item.media.selectedId = null; });
      emit({ type: "panel", panelIds: [id] });
      return copy(panel);
    },
    setSort(id, sort) {
      if (!Object.values(SORT_MODES).includes(sort)) throw new TypeError("Unknown media sort.");
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      if (current.media.sort === sort) return copy(current);
      const panel = updatePanel(id, (item) => { item.media.sort = sort; });
      emit({ type: "panel", panelIds: [id] });
      return copy(panel);
    },
    setView(id, view) {
      if (!["names", "thumbnails", "grid"].includes(view)) throw new TypeError("Unknown media view.");
      const current = state.panels.find((panel) => panel.id === id);
      if (!current) return null;
      if (current.media.view === view) return copy(current);
      const panel = updatePanel(id, (item) => { item.media.view = view; });
      emit({ type: "panel", panelIds: [id] });
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
      emit({ type: "panel", panelIds: [id] });
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
      return changed
        ? emit({ type: "panels", panelIds: state.panels.map((panel) => panel.id) })
        : copy(state);
    },
    restoreFrom(serialized) {
      state = {
        panels: restorePanels(serialized?.panels, media),
        focusedId: null,
      };
      state.focusedId = state.panels.some((panel) => panel.id === serialized?.focusedId)
        ? serialized.focusedId : state.panels.at(-1)?.id ?? null;
      return emit({
        type: "structure",
        panelIds: state.panels.map((panel) => panel.id),
        focusChanged: true,
      });
    },
  };
}
