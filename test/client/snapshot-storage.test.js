import { describe, expect, it } from "vitest";

import {
  SNAPSHOT_STORAGE_KEY,
  loadSnapshotSlots,
  saveSnapshotSlots,
} from "../../app/src/scene/snapshot-storage.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function emptySlots() {
  return new Array(8).fill(null);
}

describe("snapshot storage library reconciliation", () => {
  it("round-trips snapshot slots for the same library", () => {
    const storage = memoryStorage();
    const slots = emptySlots();
    slots[2] = {
      panels: [{ id: "panel-1", media: { directory: "photos" } }],
      focusedId: "panel-1",
      environmentMode: "dark",
      createdAt: Date.now(),
    };

    saveSnapshotSlots(storage, slots, "library-a");

    const loaded = loadSnapshotSlots(storage, "library-a");
    expect(loaded[2].panels).toEqual([{ id: "panel-1", media: { directory: "photos" } }]);
    expect(loaded[2].environmentMode).toBe("dark");
    expect(loaded[2].focusedId).toBe("panel-1");
    expect(loaded[0]).toBeNull();
  });

  it("starts empty when the persisted snapshots belong to a different library", () => {
    const storage = memoryStorage();
    saveSnapshotSlots(storage, emptySlots(), "library-a");

    expect(loadSnapshotSlots(storage, "library-b")).toEqual(emptySlots());
  });

  it("starts empty when no snapshots are stored", () => {
    const storage = memoryStorage();
    expect(loadSnapshotSlots(storage, "library-a")).toEqual(emptySlots());
  });

  it("persists the current library ID with the slots", () => {
    const storage = memoryStorage();
    saveSnapshotSlots(storage, emptySlots(), "library-a");

    expect(JSON.parse(storage.getItem(SNAPSHOT_STORAGE_KEY))).toMatchObject({
      libraryId: "library-a",
    });
  });

  it("requires a valid current library ID", () => {
    const storage = memoryStorage();
    expect(() => loadSnapshotSlots(storage, "")).toThrow("nonempty library ID");
    expect(() => saveSnapshotSlots(storage, emptySlots(), null)).toThrow("nonempty library ID");
  });
});
