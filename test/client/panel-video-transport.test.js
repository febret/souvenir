import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

const videoTransport = {
  toggleVideoPlayback: vi.fn(() => true),
  seekVideo: vi.fn((delta) => Math.max(0, delta)),
};

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
    toggleVideoPlayback(...args) {
      return videoTransport.toggleVideoPlayback(...args);
    }
    seekVideo(...args) {
      return videoTransport.seekVideo(...args);
    }
  }
  return { PanelView };
});

import { PanelCoordinator } from "../../app/src/scene/panel-coordinator.js";
import { VIDEO_SEEK_STEP_SECONDS } from "../../app/src/core/video-transport.js";

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

function createCoordinator() {
  return new PanelCoordinator({
    api: {
      directory: vi.fn(() => Promise.resolve({ entries: [] })),
      fileUrl: (path) => path,
    },
    settings: () => ({ autoplayVideos: false, mediaDirectories: [] }),
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

describe("PanelCoordinator video transport actions", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {} });
    videoTransport.toggleVideoPlayback.mockClear();
    videoTransport.seekVideo.mockClear();
  });

  it("routes the video toolbar actions to the focused panel view", () => {
    const coordinator = createCoordinator();
    const panelId = coordinator.panelState.panels[0].id;

    coordinator.handleAction(panelId, "toggle-video-playback");
    expect(videoTransport.toggleVideoPlayback).toHaveBeenCalledTimes(1);
    expect(videoTransport.seekVideo).not.toHaveBeenCalled();

    coordinator.handleAction(panelId, "seek-video-forward");
    coordinator.handleAction(panelId, "seek-video-backward");
    expect(videoTransport.seekVideo.mock.calls).toEqual([
      [VIDEO_SEEK_STEP_SECONDS],
      [-VIDEO_SEEK_STEP_SECONDS],
    ]);
  });

  it("focuses the panel that owns the video controls", () => {
    const coordinator = createCoordinator();
    const panelId = coordinator.panelState.panels[0].id;
    coordinator.handleAction(panelId, "toggle-video-playback");
    expect(coordinator.panelState.focusedId).toBe(panelId);
  });

  it("ignores video transport for a panel that no longer exists", () => {
    const coordinator = createCoordinator();
    expect(() => coordinator.handleAction("missing-panel", "seek-video-forward")).not.toThrow();
    expect(videoTransport.seekVideo).not.toHaveBeenCalled();
  });
});
