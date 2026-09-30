import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

vi.mock("../../app/src/scene/panel-view.js", async () => {
  const THREE = await import("three");
  class PanelView extends THREE.Object3D {
    dispose() {}
    applyState() {}
    setTagDefinitions() {}
    setMediaTagSelection() {}
    setSlideshowTags() {}
    setOverlayScene() {}
    setZenMode() {}
    closeOptions() {}
    showMedia() {
      return Promise.resolve(null);
    }
    tick() {}
  }
  return { PanelView };
});

import { PanelCoordinator } from "../../app/src/scene/panel-coordinator.js";
import { createSlideshowState } from "../../app/src/core/slideshow.js";

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

function createCoordinator(settings) {
  return new PanelCoordinator({
    api: {
      directory: vi.fn(() => Promise.resolve({ entries: [] })),
      fileUrl: (path) => path,
    },
    settings: () => settings,
    storage: memoryStorage(),
    libraryId: "library",
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    maskWorkflow: {
      panelRemoved: vi.fn(),
      prepareMedia: vi.fn(),
      rememberAdm: vi.fn(),
      loadPanelEffects: vi.fn(),
      draw: vi.fn(),
      setEditorSetting: vi.fn(),
      setAdmSetting: vi.fn(),
    },
    getEnvironmentMode: () => "space",
    setEnvironmentMode: vi.fn(),
    isZenMode: () => false,
    updateControls: vi.fn(),
    onPanelsChanged: vi.fn(),
    onCompositionChanged: vi.fn(),
    onError: vi.fn(),
  });
}

function activateSlideshow(coordinator) {
  const panel = coordinator.panelState.panels[0];
  const runtime = coordinator.runtimeFor(panel.id);
  runtime.playlist = [
    { id: "a.jpg", path: "a.jpg", type: "image/jpeg", name: "a.jpg" },
    { id: "b.jpg", path: "b.jpg", type: "image/jpeg", name: "b.jpg" },
  ];
  coordinator.store.setMedia(panel.id, "a.jpg");
  runtime.slideshow = createSlideshowState({
    active: true,
    intervalMs: 1000,
    currentMediaId: "a.jpg",
    lastAdvanceAt: 0,
  });
  return panel;
}

function tick(coordinator, panel, now) {
  coordinator.advanceSlideshow(coordinator.getPanel(panel.id), { type: "tick", now });
}

describe("PanelCoordinator slideshow duration", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("advances image slides at the portal duration instead of the hard-coded default", () => {
    const settings = { slideshowIntervalMs: 9000, autoplayVideos: false, mediaDirectories: [] };
    const coordinator = createCoordinator(settings);
    const panel = activateSlideshow(coordinator);
    const runtime = coordinator.runtimeFor(panel.id);

    tick(coordinator, panel, 5000);
    expect(coordinator.getPanel(panel.id).media.selectedId).toBe("a.jpg");

    tick(coordinator, panel, 8999);
    expect(coordinator.getPanel(panel.id).media.selectedId).toBe("a.jpg");
    expect(runtime.slideshow.intervalMs).toBe(9000);

    tick(coordinator, panel, 9000);
    expect(coordinator.getPanel(panel.id).media.selectedId).toBe("b.jpg");
  });

  it("re-reads the portal duration when the setting changes", () => {
    const settings = { slideshowIntervalMs: 9000, autoplayVideos: false, mediaDirectories: [] };
    const coordinator = createCoordinator(settings);
    const panel = activateSlideshow(coordinator);
    const runtime = coordinator.runtimeFor(panel.id);

    tick(coordinator, panel, 100);
    expect(runtime.slideshow.intervalMs).toBe(9000);

    settings.slideshowIntervalMs = 3000;
    tick(coordinator, panel, 2999);
    expect(runtime.slideshow.intervalMs).toBe(3000);
    expect(coordinator.getPanel(panel.id).media.selectedId).toBe("a.jpg");

    tick(coordinator, panel, 3000);
    expect(coordinator.getPanel(panel.id).media.selectedId).toBe("b.jpg");
  });
});
