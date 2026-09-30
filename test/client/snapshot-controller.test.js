import { describe, expect, it, vi } from "vitest";

import { SnapshotController } from "../../app/src/scene/snapshot-controller.js";
import { SNAPSHOT_STORAGE_KEY } from "../../app/src/scene/snapshot-storage.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function scene(overrides = {}) {
  return {
    panels: [{ id: "panel-1", media: { selectedId: "photos/a.jpg" } }],
    focusedId: "panel-1",
    environmentMode: "normal",
    ...overrides,
  };
}

function fixture({ storage = memoryStorage(), slots = null } = {}) {
  if (slots) {
    storage.setItem(
      SNAPSHOT_STORAGE_KEY,
      JSON.stringify({ libraryId: "library-a", slots }),
    );
  }
  const applied = [];
  const changes = [];
  const onError = vi.fn();
  const controller = new SnapshotController({
    storage,
    libraryId: "library-a",
    getScene: () => scene(),
    applyScene: (snapshot) => applied.push(snapshot),
    onSlotsChanged: (nextSlots, selectedIndex) => changes.push({ nextSlots, selectedIndex }),
    onError,
  });
  return { controller, storage, applied, changes, onError };
}

describe("SnapshotController", () => {
  it("captures into the first empty slot when none is selected", () => {
    const { controller, storage } = fixture();

    const captured = controller.capture();

    expect(captured.panels).toEqual(scene().panels);
    expect(controller.getSelectedIndex()).toBe(0);
    expect(controller.getSlots()[0]).not.toBeNull();
    expect(JSON.parse(storage.getItem(SNAPSHOT_STORAGE_KEY)).slots[0]).not.toBeNull();
  });

  it("overwrites the selected slot on a later capture", () => {
    const { controller } = fixture();
    controller.capture();

    controller.selectSlot(0);
    controller.capture();

    expect(controller.getSlots().filter(Boolean)).toHaveLength(1);
    expect(controller.getSelectedIndex()).toBe(0);
  });

  it("rebuilds the scene when selecting a filled slot", () => {
    const { controller, applied } = fixture();
    controller.capture();
    applied.length = 0;

    controller.selectSlot(0);

    expect(applied).toHaveLength(1);
    expect(applied[0].panels).toEqual(scene().panels);
    expect(controller.getSelectedIndex()).toBe(0);
  });

  it("does not rebuild when selecting an empty slot", () => {
    const { controller, applied } = fixture();

    controller.selectSlot(3);

    expect(controller.getSelectedIndex()).toBe(3);
    expect(applied).toHaveLength(0);
  });

  it("clears a slot and deselects it", () => {
    const { controller } = fixture();
    controller.capture();

    expect(controller.clear(0)).toBe(true);

    expect(controller.getSlots()[0]).toBeNull();
    expect(controller.getSelectedIndex()).toBeNull();
    expect(controller.clear(0)).toBe(false);
  });

  it("reports an error when capturing with all slots full and none selected", () => {
    const { controller, onError } = fixture({
      slots: new Array(8).fill(null).map(() => scene()),
    });

    expect(controller.capture()).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("loads persisted slots on construction", () => {
    const { controller } = fixture({
      slots: [null, scene({ environmentMode: "red" }), null, null, null, null, null, null],
    });

    expect(controller.getSlots()[1].environmentMode).toBe("red");
  });
});
