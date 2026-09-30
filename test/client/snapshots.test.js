import { describe, expect, it } from "vitest";

import {
  MAX_SNAPSHOTS,
  createSnapshot,
  firstEmptySlot,
  normalizeSnapshot,
  normalizeSnapshotSlots,
  snapshotCount,
} from "../../app/src/core/snapshots.js";

describe("snapshot helpers", () => {
  it("captures a deep copy of the scene and normalizes the environment", () => {
    const panels = [{ id: "panel-1", transform: { position: { x: 1, y: 2, z: 3 } } }];
    const snapshot = createSnapshot({
      panels,
      focusedId: "panel-1",
      environmentMode: "underwater",
    });
    panels[0].transform.position.x = 99;

    expect(snapshot.panels[0].transform.position.x).toBe(1);
    expect(snapshot.focusedId).toBe("panel-1");
    expect(snapshot.environmentMode).toBe("underwater");
    expect(Number.isFinite(snapshot.createdAt)).toBe(true);
  });

  it("falls back to defaults for unknown environment and focused panel", () => {
    const snapshot = createSnapshot({ panels: [], environmentMode: "bogus", focusedId: 5 });
    expect(snapshot.environmentMode).toBe("normal");
    expect(snapshot.focusedId).toBeNull();
  });

  it("normalizes slots to a fixed length and drops malformed entries", () => {
    const slots = normalizeSnapshotSlots([
      { panels: [{ id: "a" }], focusedId: "a", environmentMode: "night" },
      null,
      { notPanels: true },
      { panels: [{ noId: true }, { id: "b" }] },
    ]);

    expect(slots).toHaveLength(MAX_SNAPSHOTS);
    expect(slots[0].environmentMode).toBe("night");
    expect(slots[1]).toBeNull();
    expect(slots[2]).toBeNull();
    expect(slots[3].panels).toEqual([{ id: "b" }]);
    expect(slots[4]).toBeNull();
  });

  it("reports the first empty slot and the occupied count", () => {
    const slots = normalizeSnapshotSlots([{ panels: [] }, null, { panels: [] }]);
    expect(firstEmptySlot(slots)).toBe(1);
    expect(snapshotCount(slots)).toBe(2);
    expect(firstEmptySlot(new Array(MAX_SNAPSHOTS).fill({ panels: [] }))).toBe(-1);
  });

  it("rejects values without a panels array", () => {
    expect(normalizeSnapshot(null)).toBeNull();
    expect(normalizeSnapshot({ focusedId: "x" })).toBeNull();
  });
});
