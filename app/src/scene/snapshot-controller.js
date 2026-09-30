import { MAX_SNAPSHOTS, createSnapshot, firstEmptySlot } from "../core/index.js";
import { SNAPSHOT_STORAGE_KEY, loadSnapshotSlots, saveSnapshotSlots } from "./snapshot-storage.js";

// Owns the eight fixed scene snapshot slots, selection, and persistence.
// Capturing stores the complete serializable scene; restoring rebuilds it.
export class SnapshotController {
  constructor({
    storage,
    libraryId,
    getScene,
    applyScene,
    onSlotsChanged,
    onError,
  }) {
    this.storage = storage;
    this.libraryId = libraryId;
    this.getScene = getScene;
    this.applyScene = applyScene;
    this.onSlotsChanged = onSlotsChanged;
    this.onError = onError;
    this.disposed = false;
    this.selectedIndex = null;
    this.slots = new Array(MAX_SNAPSHOTS).fill(null);
    try {
      this.slots = loadSnapshotSlots(storage, libraryId);
    } catch (error) {
      storage.removeItem(SNAPSHOT_STORAGE_KEY);
      this.slots = new Array(MAX_SNAPSHOTS).fill(null);
      onError?.(error);
    }
    this.emit();
  }

  getSlots() {
    return this.slots.map((slot) => (slot ? { ...slot } : null));
  }

  getSelectedIndex() {
    return this.selectedIndex;
  }

  emit() {
    if (!this.disposed) this.onSlotsChanged?.(this.getSlots(), this.selectedIndex);
  }

  persist() {
    saveSnapshotSlots(this.storage, this.slots, this.libraryId);
  }

  #validIndex(index) {
    return Number.isInteger(index) && index >= 0 && index < MAX_SNAPSHOTS ? index : null;
  }

  /** Selects a slot and rebuilds the scene when that slot holds a snapshot. */
  selectSlot(index) {
    const resolved = this.#validIndex(index);
    if (resolved === null) return this.getSelectedIndex();
    this.selectedIndex = resolved;
    const slot = this.slots[resolved];
    if (slot) this.applyScene(slot);
    this.emit();
    return this.getSelectedIndex();
  }

  /**
   * Captures the current scene into the selected slot, or the first empty slot
   * when none is selected. Selects the written slot.
   */
  capture() {
    let target = this.selectedIndex;
    if (target === null) target = firstEmptySlot(this.slots);
    if (target === null || target < 0) {
      this.onError?.(new Error("All 8 snapshot slots are full. Select a snapshot to overwrite it."));
      return null;
    }
    this.slots[target] = createSnapshot(this.getScene());
    this.selectedIndex = target;
    this.persist();
    this.emit();
    return this.getSlots()[target];
  }

  clear(index) {
    const resolved = this.#validIndex(index);
    if (resolved === null || !this.slots[resolved]) return false;
    this.slots[resolved] = null;
    if (this.selectedIndex === resolved) this.selectedIndex = null;
    this.persist();
    this.emit();
    return true;
  }

  dispose() {
    this.disposed = true;
  }
}
