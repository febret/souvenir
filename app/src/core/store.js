import { createPanelStore } from "./panel-store.js";

/**
 * Renderer-independent, serializable panel state store.
 * All mutating methods publish an immutable snapshot to subscribed listeners.
 */
export class PanelStore {
  #store;

  constructor(options = {}) {
    this.#store = createPanelStore(options);
  }

  getState() { return this.#store.getState(); }
  subscribe(listener) { return this.#store.subscribe(listener); }
  add(overrides) { return this.#store.add(overrides); }
  remove(id) { return this.#store.remove(id); }
  focus(id) { return this.#store.focus(id); }
  setMedia(id, selectedId) { return this.#store.setMedia(id, selectedId); }
  setMediaScale(id, mediaKey, dimensions) {
    return this.#store.setMediaScale(id, mediaKey, dimensions);
  }
  setDirectory(id, directory) { return this.#store.setDirectory(id, directory); }
  setSort(id, sort) { return this.#store.setSort(id, sort); }
  setView(id, view) { return this.#store.setView(id, view); }
  setTagFilter(id, tagIds) { return this.#store.setTagFilter(id, tagIds); }
  reconcileTagFilters(tagIds) { return this.#store.reconcileTagFilters(tagIds); }
  setLocked(id, locked) { return this.#store.setLocked(id, locked); }
  setZoomMode(id, zoomMode) { return this.#store.setZoomMode(id, zoomMode); }
  setMaskEnabled(id, maskEnabled) {
    return this.#store.setMaskEnabled(id, maskEnabled);
  }
  setDisplayMode(id, displayMode) { return this.#store.setDisplayMode(id, displayMode); }
  setAspectRatioMode(id, aspectRatioMode) {
    return this.#store.setAspectRatioMode(id, aspectRatioMode);
  }
  setTransform(id, transform) { return this.#store.setTransform(id, transform); }
  setDimensions(id, dimensions) { return this.#store.setDimensions(id, dimensions); }
  setContentPan(id, pan) { return this.#store.setContentPan(id, pan); }
  setContentZoom(id, zoom) { return this.#store.setContentZoom(id, zoom); }
  minimize(id) { return this.#store.minimize(id); }
  restore(id) { return this.#store.restore(id); }
  restoreFrom(serialized) { return this.#store.restoreFrom(serialized); }
}
