import { describe, expect, it, vi } from "vitest";

import { MaskWorkflow } from "../../app/src/scene/mask-workflow.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function workflowFixture(api = {}, { settings = { admMaxResolution: 512 } } = {}) {
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
    updateMaskEditor: vi.fn(),
    setDepthMap: vi.fn(),
    mediaType: "image",
    getMediaDimensions: () => ({ width: 20, height: 10 }),
    getNativeImageDimensions: () => ({ width: 20, height: 10 }),
    setAdmState: vi.fn(),
    hideAdmPrompt: vi.fn(),
  };
  const loadedMedia = new Map();
  const mediaGenerations = new Map();
  const workflow = new MaskWorkflow({
    api,
    getSettings: () => settings,
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

  it("serializes ADM saves and preserves latest lighting settings", async () => {
    const firstSave = deferred();
    const secondSave = deferred();
    const api = {
      saveMediaAdm: vi.fn()
        .mockImplementationOnce(() => firstSave.promise)
        .mockImplementationOnce(() => secondSave.promise),
    };
    const { workflow } = workflowFixture(api);
    workflow.mediaAdmLookup.set("first.jpg", {
      enabled: false,
      depth_intensity: 0.35,
      soft_depth_enabled: false,
      soft_depth_blur: 12,
      fade_depth_enabled: false,
      fade_depth_start: 0.5,
      focus_blur_enabled: false,
      focus_position: "middle",
      focus_strength: "middle",
      light_fx_enabled: false,
      light_direction: "front",
      light_color: "white",
      ambient_color: "white",
      ambient_intensity: 0.5,
    });

    workflow.setAdmSetting("panel-1", "lightColor", "warm");
    workflow.setAdmSetting("panel-1", "ambientColor", "mint");

    await vi.waitFor(() => expect(api.saveMediaAdm).toHaveBeenCalledTimes(1));
    expect(workflow.mediaAdmLookup.get("first.jpg")?.light_color).toBe("warm");
    expect(workflow.mediaAdmLookup.get("first.jpg")?.ambient_color).toBe("mint");

    firstSave.resolve({
      enabled: false,
      depth_intensity: 0.35,
      light_color: "warm",
      ambient_color: "white",
    });
    await vi.waitFor(() => expect(api.saveMediaAdm).toHaveBeenCalledTimes(2));
    expect(api.saveMediaAdm.mock.calls[1][3]).toMatchObject({
      light_color: "warm",
      ambient_color: "mint",
    });

    secondSave.resolve({
      enabled: false,
      depth_intensity: 0.35,
      light_color: "warm",
      ambient_color: "mint",
    });
    await vi.waitFor(() => {
      expect(workflow.mediaAdmLookup.get("first.jpg")?.light_color).toBe("warm");
      expect(workflow.mediaAdmLookup.get("first.jpg")?.ambient_color).toBe("mint");
    });
  });

  it("uses configured resolution for auto mask requests", async () => {
    const api = {
      requestAutoMask: vi.fn().mockResolvedValue({ status: "queued" }),
    };
    const { workflow } = workflowFixture(api, { settings: { admMaxResolution: 1024 } });
    const pollAutoMask = vi.spyOn(workflow, "pollAutoMask").mockResolvedValue();
    const editor = { panelId: "panel-1", path: "first.jpg", canvas: {}, autoMaskBusy: false };

    await workflow.startAutoMask(editor);

    expect(api.requestAutoMask).toHaveBeenCalledWith("first.jpg", 1024);
    expect(pollAutoMask).toHaveBeenCalledWith("first.jpg", 1);
  });

  it("uses configured resolution for ADM generation requests", async () => {
    const api = {
      requestAdm: vi.fn().mockResolvedValue({ status: "queued" }),
    };
    const { panels, workflow } = workflowFixture(api, { settings: { admMaxResolution: 512 } });
    workflow.saveMediaAdm = vi.fn().mockResolvedValue({});
    workflow.pollAdm = vi.fn().mockResolvedValue();

    await workflow.confirmAdmGeneration(panels[0]);

    expect(api.requestAdm).toHaveBeenCalledWith("first.jpg", 512);
  });

  it("deletes saved depth data and disables ADM for the media", async () => {
    const api = {
      deleteDepth: vi.fn().mockResolvedValue({ exists: false }),
    };
    const { panels, workflow } = workflowFixture(api);
    workflow.depthCache.set("first.jpg", { canvas: { depth: true } });
    workflow.saveMediaAdm = vi.fn().mockResolvedValue({});

    await workflow.deleteDepth(panels[0]);

    expect(api.deleteDepth).toHaveBeenCalledWith("first.jpg");
    expect(workflow.depthCache.has("first.jpg")).toBe(false);
    expect(workflow.saveMediaAdm).toHaveBeenCalledWith("first.jpg", {
      enabled: false,
      depthIntensity: panels[0].depthIntensity,
    });
  });
});
