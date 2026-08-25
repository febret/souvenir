import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAVE_MODE,
  SAVE_MODES,
  normalizeSaveMode,
  restorePanel,
} from "../../app/src/core/panel-store.js";
import { normalizeTagIds } from "../../app/src/core/tags.js";
import { PanelStore } from "../../app/src/core/store.js";

const media = [{ id: "beach", directory: "photos" }];

describe("panel model and store", () => {
  it("adds, focuses, selects media, and exposes serializable snapshots", () => {
    const store = new PanelStore({ media, idFactory: () => "one" });
    store.add();
    store.setDirectory("one", "photos");
    store.setMedia("one", "beach");
    expect(store.getState()).toMatchObject({
      focusedId: "one",
      panels: [{ id: "one", media: { directory: "photos", selectedId: "beach", sort: "name", view: "names" } }],
    });
    expect(() => JSON.stringify(store.getState())).not.toThrow();
    expect(store.focus("missing")).toBe(false);
  });

  it("defaults save mode to scale and normalizes malformed modes", () => {
    const store = new PanelStore({ idFactory: () => "one" });
    expect(store.add().saveMode).toBe(DEFAULT_SAVE_MODE);
    expect(SAVE_MODES).toEqual(["disabled", "scale", "full"]);
    expect(normalizeSaveMode("broken")).toBe(DEFAULT_SAVE_MODE);
    expect(normalizeSaveMode("full")).toBe("full");
  });

  it("defensively clears unavailable media during restoration", () => {
    const panel = restorePanel({ id: "one", media: { directory: "gone", selectedId: "missing" } }, media);
    expect(panel.media).toMatchObject({ directory: null, selectedId: null });
  });

  it("remembers panel scale per media and restores it when switching back", () => {
    const store = new PanelStore({ media, idFactory: () => "one" });
    store.add();
    store.setDirectory("one", "photos");
    store.setMedia("one", "beach");
    store.setDimensions("one", { width: 2, height: 1.4 });

    // Switching away records the outgoing media's saved scale.
    store.setMedia("one", "other");
    expect(store.getState().panels[0].mediaPoses.beach.scale).toEqual({ width: 2, height: 1.4 });

    // Switching back restores that media's own scale.
    store.setMedia("one", "beach");
    expect(store.getState().panels[0].dimensions).toEqual({ width: 2, height: 1.4 });
  });

  it("saves and restores the full pose only in full save mode", () => {
    const store = new PanelStore({ media, idFactory: () => "one" });
    store.add({ saveMode: "full" });
    store.setDirectory("one", "photos");
    store.setMedia("one", "beach");
    store.setTransform("one", { position: { x: 1, y: 2, z: -3 }, rotation: { y: 0.5 } });
    store.setDimensions("one", { width: 2, height: 1.4 });

    store.setMedia("one", "other");
    const pose = store.getState().panels[0].mediaPoses.beach;
    expect(pose.transform.position).toEqual({ x: 1, y: 2, z: -3 });
    expect(pose.transform.rotation.y).toBeCloseTo(0.5);
    expect(pose.scale).toEqual({ width: 2, height: 1.4 });

    // Restoring brings back both scale and pose.
    store.setMedia("one", "beach");
    expect(store.getState().panels[0]).toMatchObject({
      dimensions: { width: 2, height: 1.4 },
      transform: { position: { x: 1, y: 2, z: -3 }, rotation: { y: 0.5 } },
    });
  });

  it("never restores poses in disabled save mode", () => {
    const store = new PanelStore({
      media,
      idFactory: () => "one",
      panels: [{
        id: "one",
        saveMode: "disabled",
        dimensions: { width: 2, height: 1.4 },
        transform: { position: { x: 5, y: 0, z: -1 } },
        mediaPoses: { beach: { scale: { width: 0.5, height: 0.25 }, transform: { position: { x: 9, y: 9, z: 9 }, rotation: { y: 1 } } } },
      }],
    });
    store.setMedia("one", "beach");
    const panel = store.getState().panels[0];
    expect(panel.dimensions).toEqual({ width: 2, height: 1.4 });
    expect(panel.transform.position.x).toBe(5);
    expect(panel.mediaPoses).toEqual({});
  });

  it("drops per-media poses when downgrading save mode to disabled", () => {
    const store = new PanelStore({ media, idFactory: () => "one" });
    store.add();
    store.setDirectory("one", "photos");
    store.setMedia("one", "beach");
    store.setDimensions("one", { width: 2, height: 1.4 });
    expect(Object.keys(store.getState().panels[0].mediaPoses)).toEqual(["beach"]);

    store.setSaveMode("one", "disabled");
    expect(store.getState().panels[0].mediaPoses).toEqual({});
    expect(store.setSaveMode("missing", "full")).toBeNull();

    // Upgrading re-records the current media immediately.
    store.setSaveMode("one", "full");
    expect(store.getState().panels[0].mediaPoses.beach.transform).toBeDefined();
  });

  it("migrates legacy mediaScales into scale-only media poses", () => {
    const store = new PanelStore({
      media,
      panels: [{
        id: "one",
        mediaScales: { beach: { width: 2, height: 1.4 } },
      }],
    });
    expect(store.getState().panels[0].mediaPoses.beach)
      .toMatchObject({ scale: { width: 2, height: 1.4 } });

    // Switching back restores the migrated scale.
    store.setMedia("one", "beach");
    expect(store.getState().panels[0].dimensions).toEqual({ width: 2, height: 1.4 });
  });

  it("keeps independent poses for different media and serializes them", () => {
    const store = new PanelStore({ media, idFactory: () => "one" });
    store.add();
    store.setDirectory("one", "photos");
    store.setMedia("one", "beach");
    store.setDimensions("one", { width: 2, height: 1.4 });
    store.setMedia("one", "cliff");
    store.setDimensions("one", { width: 0.8, height: 0.6 });

    expect(store.getState().panels[0].mediaPoses).toMatchObject({
      beach: { scale: { width: 2, height: 1.4 } },
      cliff: { scale: { width: 0.8, height: 0.6 } },
    });

    const serialized = JSON.parse(JSON.stringify(store.getState()));
    const restored = new PanelStore(serialized);
    expect(restored.getState().panels[0].mediaPoses).toMatchObject({
      beach: { scale: { width: 2, height: 1.4 } },
      cliff: { scale: { width: 0.8, height: 0.6 } },
    });
  });

  it("retains saved media until an availability list has loaded", () => {
    const store = new PanelStore({
      panels: [
        {
          id: "one",
          media: { directory: "photos", selectedId: "beach" },
        },
      ],
    });
    expect(store.getState().panels[0].media).toMatchObject({
      directory: "photos",
      selectedId: "beach",
    });
  });

  it("notifies subscriptions and removes the focused panel", () => {
    const store = new PanelStore({ idFactory: (() => { let id = 0; return () => `p${++id}`; })() });
    const snapshots = [];
    const unsubscribe = store.subscribe((state) => snapshots.push(state));
    store.add();
    store.add();
    store.remove("p2");
    unsubscribe();
    expect(store.getState().focusedId).toBe("p1");
    expect(snapshots).toHaveLength(3);
  });

  it("does not publish idempotent focus or pose updates", () => {
    const store = new PanelStore({ idFactory: () => "one" });
    store.add();
    const changes = [];
    const unsubscribe = store.subscribe((_state, change) => changes.push(change));

    expect(store.focus("one")).toBe(true);
    store.setPose("one", {
      transform: {
        position: { x: 0, y: 0, z: -1 },
        rotation: { x: 0, y: 0, z: 0 },
      },
      dimensions: { width: 1.2, height: 0.8 },
    });
    expect(changes).toEqual([]);

    store.setPose("one", {
      transform: {
        position: { x: 0.2, y: 1, z: -1.5 },
        rotation: { x: 0, y: 0.1, z: 0 },
      },
      dimensions: { width: 1.4, height: 0.9 },
    });
    unsubscribe();

    expect(changes).toEqual([{ type: "panel", panelIds: ["one"] }]);
    expect(store.getState().panels[0]).toMatchObject({
      transform: {
        position: { x: 0.2, y: 1, z: -1.5 },
        rotation: { x: 0, y: 0.1, z: 0 },
      },
      dimensions: { width: 1.4, height: 0.9 },
    });
  });

  it("minimizes and restores panel dimensions without losing its pose", () => {
    const store = new PanelStore({ idFactory: () => "one" });
    store.add({
      dimensions: { width: 1.8, height: 1.2 },
      transform: { position: { x: 0.3, y: 1.4, z: -1.6 } },
    });

    expect(store.minimize("one")).toMatchObject({
      minimized: true,
      dimensions: { width: 0.28, height: 0.18 },
      restoreDimensions: { width: 1.8, height: 1.2 },
    });
    expect(store.getState().panels[0].transform.position).toMatchObject({
      x: 0.3,
      y: 1.4,
      z: -1.6,
    });
    expect(store.restore("one")).toMatchObject({
      minimized: false,
      dimensions: { width: 1.8, height: 1.2 },
    });
  });

  it("defaults mask visibility on, persists it, and isolates the mask setter to its panel", () => {
    const store = new PanelStore({
      idFactory: (() => { let index = 0; return () => `panel-${++index}`; })(),
    });
    expect(store.add().maskEnabled).toBe(true);
    store.add();
    expect(store.setMaskEnabled("panel-1", false)).toMatchObject({ maskEnabled: false });
    expect(store.getState().panels[1].maskEnabled).toBe(true);

    const restored = new PanelStore(JSON.parse(JSON.stringify(store.getState())));
    expect(restored.getState().panels[0].maskEnabled).toBe(false);
    expect(restored.setMaskEnabled("panel-1", true)).toMatchObject({ maskEnabled: true });
    expect(restored.setMaskEnabled("missing", false)).toBeNull();
  });

  it("defaults, normalizes, persists, and updates panel tag filters through the store", () => {
    expect(normalizeTagIds([" horse ", 3, "", null, "horse", "3", {}]))
      .toEqual(["horse", "3"]);
    const store = new PanelStore({ idFactory: () => "one" });
    expect(store.add().tagFilter).toEqual([]);

    expect(store.setTagFilter("one", [" horse ", 3, "", "horse", "3"]))
      .toMatchObject({ tagFilter: ["horse", "3"] });
    expect(store.setTagFilter("missing", ["horse"])).toBeNull();

    const restored = new PanelStore(JSON.parse(JSON.stringify(store.getState())));
    expect(restored.getState().panels[0].tagFilter).toEqual(["horse", "3"]);
    expect(restored.setTagFilter("one", null)).toMatchObject({ tagFilter: [] });
  });

  it("reconciles persisted tag filters after definitions are deleted", () => {
    const store = new PanelStore({
      panels: [
        { id: "one", tagFilter: ["horse", "blue"] },
        { id: "two", tagFilter: ["portrait"] },
      ],
    });

    expect(store.reconcileTagFilters(["horse", "portrait"]).panels)
      .toMatchObject([
        { id: "one", tagFilter: ["horse"] },
        { id: "two", tagFilter: ["portrait"] },
      ]);
    expect(store.reconcileTagFilters(["horse", "portrait"]).panels[0].tagFilter)
      .toEqual(["horse"]);
  });
});
