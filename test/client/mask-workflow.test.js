import { describe, expect, it, vi } from "vitest";

import { MaskWorkflow } from "../../app/src/scene/mask-workflow.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function workflowFixture(api = {}) {
  const panels = [{
    id: "panel-1",
    media: { selectedId: "first.jpg" },
    maskEnabled: true,
    admEnabled: false,
    depthIntensity: 0.35,
  }];
  const view = {
    setMask: vi.fn(),
    setMaskAvailable: vi.fn(),
    setDepthMap: vi.fn(),
    getMediaDimensions: () => ({ width: 20, height: 10 }),
    getNativeImageDimensions: () => ({ width: 20, height: 10 }),
    setAdmState: vi.fn(),
  };
  const loadedMedia = new Map();
  const mediaGenerations = new Map();
  const workflow = new MaskWorkflow({
    api,
    getPanels: () => panels,
    getPanel: (id) => panels.find((panel) => panel.id === id),
    getPanelView: (id) => id === "panel-1" ? view : null,
    getRuntimes: () => new Map(),
    setMaskEnabled: vi.fn(),
    setAdmEnabled: vi.fn(),
    setDepthIntensity: vi.fn(),
    isSlideshowActive: () => false,
    stopSlideshow: vi.fn(),
    isCurrentMediaRequest: (id, path, generation) => (
      mediaGenerations.get(id) === generation
      && panels.find((panel) => panel.id === id)?.media.selectedId === path
    ),
    getMediaGeneration: (id) => mediaGenerations.get(id) ?? 0,
    onError: vi.fn(),
    delay: () => Promise.resolve(),
    canvasFromBlob: vi.fn(() => Promise.resolve({ canvas: true })),
  });
  const beginMedia = (id, item) => {
    const generation = (mediaGenerations.get(id) ?? 0) + 1;
    mediaGenerations.set(id, generation);
    loadedMedia.set(id, item.path);
    workflow.prepareMedia(id, item);
    return generation;
  };
  return { panels, view, workflow, beginMedia, loadedMedia };
}

describe("MaskWorkflow", () => {
  it("guards mask responses from stale media requests", async () => {
    const info = deferred();
    const api = {
      maskInfo: vi.fn(() => info.promise),
      loadMask: vi.fn(),
    };
    const { panels, view, workflow, beginMedia, loadedMedia } = workflowFixture(api);
    const firstGeneration = beginMedia("panel-1", { path: "first.jpg" });
    const loading = workflow.loadMaskForPanel(
      "panel-1",
      { path: "first.jpg" },
      firstGeneration,
    );

    panels[0].media.selectedId = "second.jpg";
    beginMedia("panel-1", { path: "second.jpg" });
    info.resolve({ exists: true, blur: 0.2 });
    await loading;

    expect(api.loadMask).not.toHaveBeenCalled();
    expect(view.setMask).toHaveBeenCalledTimes(2);
    expect(loadedMedia.get("panel-1")).toBe("second.jpg");
  });

  it("cancels active ADM polling during stop", async () => {
    const status = deferred();
    const api = { admStatus: vi.fn(() => status.promise) };
    const { workflow } = workflowFixture(api);
    const polling = workflow.pollAdm("first.jpg");

    workflow.stop();
    status.resolve({ status: "running" });
    await polling;

    expect(api.admStatus).toHaveBeenCalledTimes(1);
    expect(workflow.autoAdmPollers.size).toBe(0);
  });
});
