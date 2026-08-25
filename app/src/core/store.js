import { createPanelStore } from "./panel-store.js";

/**
 * Renderer-independent, serializable panel state store.
 * Effective mutations publish an immutable snapshot and a compact change
 * descriptor; idempotent writes do not notify subscribers.
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
  setMediaContext(id, context) { return this.#store.setMediaContext(id, context); }
  setMediaPose(id, mediaKey, pose) {
    return this.#store.setMediaPose(id, mediaKey, pose);
  }
  setSaveMode(id, mode) { return this.#store.setSaveMode(id, mode); }
  setDirectory(id, directory) { return this.#store.setDirectory(id, directory); }
  setSort(id, sort) { return this.#store.setSort(id, sort); }
  setView(id, view) { return this.#store.setView(id, view); }
  setTagFilter(id, tagIds) { return this.#store.setTagFilter(id, tagIds); }
  reconcileTagFilters(tagIds) { return this.#store.reconcileTagFilters(tagIds); }
  setLocked(id, locked) { return this.#store.setLocked(id, locked); }
  minimize(id) { return this.#store.minimize(id); }
  restore(id) { return this.#store.restore(id); }
  setMaskEnabled(id, maskEnabled) {
    return this.#store.setMaskEnabled(id, maskEnabled);
  }
  setAdmEnabled(id, enabled) { return this.#store.setAdmEnabled(id, enabled); }
  setDepthIntensity(id, value) { return this.#store.setDepthIntensity(id, value); }
  setTransform(id, transform) { return this.#store.setTransform(id, transform); }
  setPose(id, pose) { return this.#store.setPose(id, pose); }
  setDimensions(id, dimensions) { return this.#store.setDimensions(id, dimensions); }
  restoreFrom(serialized) { return this.#store.restoreFrom(serialized); }
}
