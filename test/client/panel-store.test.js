import { describe, expect, it } from "vitest";
import {
  ASPECT_RATIO_MODES,
  DEFAULT_ASPECT_RATIO_MODE,
} from "../../app/src/core/aspect-ratio.js";
import {
  MINIMIZED_DIMENSIONS,
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

  it("minimizes to fixed dimensions and restores the saved dimensions", () => {
    const store = new PanelStore({ idFactory: () => "one" });
    store.add({ dimensions: { width: 2, height: 1 } });
    store.setTransform("one", { position: { x: 1, y: 2, z: 3 } });
    store.setContentPan("one", { x: 0.5, y: 0 });
    store.setContentZoom("one", 2);
    store.minimize("one");
    expect(store.getState().panels[0].dimensions).toEqual(MINIMIZED_DIMENSIONS);
    store.restore("one");
    expect(store.getState().panels[0]).toMatchObject({
      dimensions: { width: 2, height: 1 },
      transform: { position: { x: 1, y: 2, z: 3 } },
      content: { pan: { x: 0.5, y: 0, z: 0 }, zoom: 2 },
    });
  });

  it("retains clamped locked content zoom and pan while minimized and restored", () => {
    const store = new PanelStore({ idFactory: () => "one" });
    store.add({
      locked: true,
      content: { pan: { x: 0.5, y: -0.25, z: 0 }, zoom: 2 },
      dimensions: { width: 2, height: 1 },
    });
    store.setContentPan("one", { x: 1, y: 2, z: 3 });
    store.setContentZoom("one", 100);
    store.minimize("one");
    store.setContentZoom("one", 0);
    store.restore("one");

    expect(store.getState().panels[0]).toMatchObject({
      locked: true,
      minimized: false,
      dimensions: { width: 2, height: 1 },
      content: { pan: { x: 1, y: 2, z: 3 }, zoom: 0.25 },
    });
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

    // Switching away records the outgoing media's panel scale.
    store.setMedia("one", "other");
    expect(store.getState().panels[0].mediaScales.beach).toEqual({ width: 2, height: 1.4 });

    // Switching back restores that media's own panel scale.
    store.setMedia("one", "beach");
    expect(store.getState().panels[0].dimensions).toEqual({ width: 2, height: 1.4 });
  });

  it("keeps independent scales for different media and serializes them", () => {
    const store = new PanelStore({ media, idFactory: () => "one" });
    store.add();
    store.setDirectory("one", "photos");
    store.setMedia("one", "beach");
    store.setDimensions("one", { width: 2, height: 1.4 });
    store.setMedia("one", "cliff");
    store.setDimensions("one", { width: 0.8, height: 0.6 });

    expect(store.getState().panels[0].mediaScales).toMatchObject({
      beach: { width: 2, height: 1.4 },
      cliff: { width: 0.8, height: 0.6 },
    });

    const serialized = JSON.parse(JSON.stringify(store.getState()));
    const restored = new PanelStore(serialized);
    expect(restored.getState().panels[0].mediaScales).toMatchObject({
      beach: { width: 2, height: 1.4 },
      cliff: { width: 0.8, height: 0.6 },
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

  it("serializes, restores, and validates the display mode through the store setter", () => {
    const store = new PanelStore({ idFactory: () => "one" });
    expect(store.add().displayMode).toBe("fit");
    expect(store.setDisplayMode("one", "actual")).toMatchObject({ displayMode: "actual" });

    const serialized = JSON.parse(JSON.stringify(store.getState()));
    const restored = new PanelStore(serialized);
    expect(restored.getState().panels[0].displayMode).toBe("actual");

    expect(restored.setDisplayMode("one", "not-a-mode")).toMatchObject({ displayMode: "fit" });
    expect(restored.setDisplayMode("missing", "fill")).toBeNull();
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

  it("persists, restores, and validates aspect ratio modes through the store setter", () => {
    const store = new PanelStore({ idFactory: () => "one" });
    expect(store.add().aspectRatioMode).toBe(DEFAULT_ASPECT_RATIO_MODE);
    expect(store.setAspectRatioMode("one", ASPECT_RATIO_MODES.SIXTEEN_NINE))
      .toMatchObject({ aspectRatioMode: ASPECT_RATIO_MODES.SIXTEEN_NINE });

    const serialized = JSON.parse(JSON.stringify(store.getState()));
    const restored = new PanelStore(serialized);
    expect(restored.getState().panels[0].aspectRatioMode)
      .toBe(ASPECT_RATIO_MODES.SIXTEEN_NINE);
    expect(restored.setAspectRatioMode("one", "broken"))
      .toMatchObject({ aspectRatioMode: DEFAULT_ASPECT_RATIO_MODE });
    expect(restored.setAspectRatioMode("missing", ASPECT_RATIO_MODES.SQUARE)).toBeNull();
  });

  it("defaults malformed restored aspect ratio modes and retains ratio dimensions while minimized", () => {
    const store = new PanelStore({
      panels: [{
        id: "one",
        aspectRatioMode: "unsupported",
        dimensions: { width: 1.2, height: 0.8 },
      }],
    });
    expect(store.getState().panels[0].aspectRatioMode).toBe(DEFAULT_ASPECT_RATIO_MODE);

    store.minimize("one");
    store.setAspectRatioMode("one", ASPECT_RATIO_MODES.NINE_SIXTEEN);
    store.setDimensions("one", { width: 1.2, height: 2.1333333333333333 });
    expect(store.getState().panels[0]).toMatchObject({
      minimized: true,
      dimensions: MINIMIZED_DIMENSIONS,
      aspectRatioMode: ASPECT_RATIO_MODES.NINE_SIXTEEN,
      restoreDimensions: { width: 1.2, height: 2.1333333333333333 },
    });
    store.restore("one");
    expect(store.getState().panels[0].dimensions)
      .toEqual({ width: 1.2, height: 2.1333333333333333 });
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
