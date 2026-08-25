import {
  binaryEraseMaskCanvas,
  canvasToPng,
  clampBrushSize,
  clampMaskBlur,
  clearEraseMask,
  cloneEraseMaskCanvas,
  createEraseMaskCanvas,
  eraseMaskHasPaint,
  paintEraseStroke,
} from "../core/index.js";

const MAX_CACHED_MASKS = 8;
const AUTO_MASK_POLL_INTERVAL_MS = 550;
const AUTO_ADM_POLL_INTERVAL_MS = 700;

async function blobToCanvas(blob, dimensions, createCanvas) {
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise((resolve, reject) => {
      const next = new Image();
      next.onload = () => resolve(next);
      next.onerror = () => reject(new Error("The image data could not be decoded."));
      next.src = url;
    });
    const canvas = createCanvas(dimensions.width, dimensions.height);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Owns erase-mask, depth-map, and ADM state, requests, editing, and polling lifecycles.
export class MaskWorkflow {
  constructor({
    api,
    getSettings = () => ({}),
    getPanels,
    getPanel,
    getPanelView,
    getRuntimes,
    setMaskEnabled,
    setAdmEnabled,
    setDepthIntensity,
    isSlideshowActive,
    stopSlideshow,
    isCurrentMediaRequest,
    getMediaGeneration,
    onError,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    canvasFromBlob = blobToCanvas,
  }) {
    this.api = api;
    this.getSettings = getSettings;
    this.getPanels = getPanels;
    this.getPanel = getPanel;
    this.getPanelView = getPanelView;
    this.getRuntimes = getRuntimes;
    this.setMaskEnabled = setMaskEnabled;
    this.setAdmEnabled = setAdmEnabled;
    this.setDepthIntensity = setDepthIntensity;
    this.isSlideshowActive = isSlideshowActive;
    this.stopSlideshow = stopSlideshow;
    this.isCurrentMediaRequest = isCurrentMediaRequest;
    this.getMediaGeneration = getMediaGeneration;
    this.onError = onError;
    this.delay = delay;
    this.canvasFromBlob = canvasFromBlob;
    this.maskVersions = new Map();
    this.maskCache = new Map();
    this.depthCache = new Map();
    this.autoMaskStates = new Map();
    this.autoMaskGeneration = new Map();
    this.autoMaskPollers = new Map();
    this.autoAdmStates = new Map();
    this.autoAdmPollers = new Map();
    this.mediaAdmLookup = new Map();
    this.editor = null;
    this.disposed = false;
  }

  rememberAdm(media) {
    for (const item of Array.isArray(media) ? media : [media]) {
      const path = String(item?.path ?? item?.id ?? "").trim();
      if (!path) continue;
      this.mediaAdmLookup.set(path, {
        enabled: Boolean(item?.adm?.enabled),
        depth_intensity: this.resolveDepthIntensity(item?.adm),
      });
    }
  }

  defaultDepthIntensity() {
    const value = this.getSettings()?.admDefaultDepthIntensity;
    return Number.isFinite(value) ? value : 0.35;
  }

  resolveDepthIntensity(adm) {
    return adm?.enabled && Number.isFinite(adm.depth_intensity)
      ? adm.depth_intensity
      : this.defaultDepthIntensity();
  }

  panelRemoved(panelId) {
    if (this.editor?.panelId === panelId) this.editor = null;
  }

  prepareMedia(panelId, item) {
    if (this.editor?.panelId === panelId && this.editor.path !== item.path) {
      this.cancelEditor({ restore: false });
    }
    this.rememberAdm(item);
    const view = this.getPanelView(panelId);
    view?.setMask(null);
    view?.setMaskAvailable(false);
    view?.setDepthMap(null);
  }

  loadPanelEffects(panelId, item, generation) {
    this.loadMaskForPanel(panelId, item, generation).catch((error) => {
      if (this.isCurrentMediaRequest(panelId, item.path, generation)) {
        this.onError?.(new Error(`Could not load erase mask: ${error.message}`));
      }
    });
    this.applyAdmForPanel(panelId, item, generation).catch((error) => {
      if (this.isCurrentMediaRequest(panelId, item.path, generation)) {
        this.onError?.(new Error(`Could not apply depth mode: ${error.message}`));
      }
    });
  }

  async loadMaskForPanel(panelId, item, generation) {
    const maskVersion = this.maskVersions.get(item.path) ?? 0;
    const info = await this.api.maskInfo(item.path);
    if (!this.isCurrentMediaRequest(panelId, item.path, generation)
      || (this.maskVersions.get(item.path) ?? 0) !== maskVersion) return;
    const view = this.getPanelView(panelId);
    if (!info?.exists) {
      this.maskCache.delete(item.path);
      view.setMask(null);
      view.setMaskAvailable(false);
      return;
    }
    const blob = await this.api.loadMask(item.path);
    if (!this.isCurrentMediaRequest(panelId, item.path, generation)
      || (this.maskVersions.get(item.path) ?? 0) !== maskVersion) return;
    const dimensions = view.getMediaDimensions();
    if (!dimensions) return;
    const canvas = await this.canvasFromBlob(blob, dimensions, createEraseMaskCanvas);
    if (!this.isCurrentMediaRequest(panelId, item.path, generation)
      || (this.maskVersions.get(item.path) ?? 0) !== maskVersion) return;
    const record = { canvas, blur: clampMaskBlur(info.blur) };
    this.cacheMask(item.path, record);
    const panel = this.getPanel(panelId);
    view.setMask(record.canvas, { blur: record.blur, enabled: panel?.maskEnabled !== false });
    view.setMaskAvailable(true);
  }

  async applyAdmForPanel(panelId, item, generation) {
    const panel = this.getPanel(panelId);
    const view = this.getPanelView(panelId);
    if (!panel || !view || !view.getNativeImageDimensions()) return;
    const path = item.path;
    let adm = this.mediaAdmLookup.get(path);
    if (!adm) {
      adm = await this.api.mediaAdm(path);
      this.mediaAdmLookup.set(path, {
        enabled: Boolean(adm?.enabled),
        depth_intensity: this.resolveDepthIntensity(adm),
      });
    }
    if (!this.isCurrentMediaRequest(panelId, path, generation)) return;
    const enabled = Boolean(adm?.enabled);
    const intensity = this.resolveDepthIntensity(adm);
    this.setAdmEnabled(panelId, enabled);
    this.setDepthIntensity(panelId, intensity);
    view.setAdmState({ enabled, intensity, busy: this.autoAdmBusy(path) });
    if (!enabled) {
      view.setDepthMap(null);
      return;
    }
    const depth = await this.loadDepthForPath(path, panelId, generation);
    if (depth && this.isCurrentMediaRequest(panelId, path, generation)) view.setDepthMap(depth.canvas);
  }

  async loadDepthForPath(path, panelId, generation) {
    const cached = this.depthCache.get(path);
    if (cached) return cached;
    const info = await this.api.depthInfo(path);
    if (!this.isCurrentMediaRequest(panelId, path, generation) || !info?.exists) return null;
    const blob = await this.api.loadDepth(path);
    if (!this.isCurrentMediaRequest(panelId, path, generation)) return null;
    const dimensions = this.getPanelView(panelId)?.getNativeImageDimensions();
    if (!dimensions) return null;
    const canvas = await this.canvasFromBlob(blob, dimensions, createEraseMaskCanvas);
    if (!this.isCurrentMediaRequest(panelId, path, generation)) return null;
    canvas.userData = {
      ...canvas.userData,
      gridSegments: this.getSettings()?.admMaxResolution,
    };
    const record = { canvas, updated_at: info.updated_at ?? null };
    this.depthCache.set(path, record);
    return record;
  }

  updatePanelsForMediaAdm(path, { enabled, depthIntensity } = {}) {
    const current = this.mediaAdmLookup.get(path) ?? {
      enabled: false,
      depth_intensity: this.defaultDepthIntensity(),
    };
    const next = {
      enabled: enabled == null ? current.enabled : Boolean(enabled),
      depth_intensity: Number.isFinite(depthIntensity) ? depthIntensity : current.depth_intensity,
    };
    this.mediaAdmLookup.set(path, next);
    for (const [panelId, runtime] of this.getRuntimes()) {
      for (const item of runtime.playlist) {
        if (item.path === path) item.adm = { enabled: next.enabled, depth_intensity: next.depth_intensity };
      }
      const panel = this.getPanel(panelId);
      if (!panel || panel.media.selectedId !== path) continue;
      this.setAdmEnabled(panel.id, next.enabled);
      this.setDepthIntensity(panel.id, next.depth_intensity);
      const view = this.getPanelView(panel.id);
      view?.setAdmState({
        enabled: next.enabled,
        intensity: next.depth_intensity,
        busy: this.autoAdmBusy(path),
      });
      if (!next.enabled) view?.setDepthMap(null);
      else {
        const depth = this.depthCache.get(path);
        if (depth) view?.setDepthMap(depth.canvas);
      }
    }
  }

  toggleMask(panel) {
    const record = this.maskCache.get(panel.media.selectedId);
    if (!record) return;
    const enabled = !panel.maskEnabled;
    this.setMaskEnabled(panel.id, enabled);
    this.getPanelView(panel.id)?.setMask(record.canvas, {
      blur: record.blur,
      enabled,
    });
  }

  async toggleAdm(panel) {
    const path = panel.media.selectedId;
    const view = this.getPanelView(panel.id);
    if (!path || !view || !view.getNativeImageDimensions()) {
      throw new Error("Select an image before enabling 3D mode.");
    }
    const enabled = !panel.admEnabled;
    if (!enabled) {
      await this.saveMediaAdm(path, { enabled: false, depthIntensity: panel.depthIntensity });
      return;
    }
    const depth = this.depthCache.get(path);
    if (depth) {
      await this.saveMediaAdm(path, { enabled: true, depthIntensity: panel.depthIntensity });
      view.setDepthMap(depth.canvas);
      return;
    }
    const info = await this.api.depthInfo(path);
    if (info?.exists) {
      const generation = this.getMediaGeneration(panel.id);
      const record = await this.loadDepthForPath(path, panel.id, generation);
      await this.saveMediaAdm(path, { enabled: true, depthIntensity: panel.depthIntensity });
      if (record) view.setDepthMap(record.canvas);
      return;
    }
    view.showAdmPrompt();
  }

  async confirmAdmGeneration(panel) {
    const path = panel.media.selectedId;
    const view = this.getPanelView(panel.id);
    if (!path || !view) return;
    view.hideAdmPrompt();
    view.setAdmState({ enabled: true, intensity: panel.depthIntensity, busy: true });
    await this.saveMediaAdm(path, { enabled: true, depthIntensity: panel.depthIntensity });
    const state = await this.api.requestAdm(path);
    this.autoAdmStates.set(path, state);
    await this.pollAdm(path);
  }

  cancelAdmGeneration(panel) {
    this.getPanelView(panel.id)?.hideAdmPrompt();
  }

  async saveMediaAdm(path, { enabled, depthIntensity }) {
    const saved = await this.api.saveMediaAdm(path, enabled, depthIntensity);
    this.updatePanelsForMediaAdm(path, {
      enabled: saved?.enabled ?? enabled,
      depthIntensity: saved?.depth_intensity ?? depthIntensity,
    });
  }

  setAdmSetting(panelId, setting, value) {
    if (setting !== "depthIntensity") throw new TypeError(`Unknown ADM setting: ${setting}`);
    const panel = this.getPanel(panelId);
    if (!panel || !panel.media.selectedId) return;
    this.setDepthIntensity(panel.id, value);
    this.saveMediaAdm(panel.media.selectedId, {
      enabled: panel.admEnabled,
      depthIntensity: value,
    }).catch((error) => {
      this.onError?.(new Error(`Could not save depth intensity: ${error.message}`));
    });
  }

  autoAdmBusy(path) {
    const status = this.autoAdmStates.get(path)?.status ?? "idle";
    return status === "queued" || status === "running";
  }

  beginEditor(panel) {
    const view = this.getPanelView(panel.id);
    const dimensions = view?.getMediaDimensions();
    if (!view || !dimensions) {
      this.onError?.(new Error("Load an image or video before editing its erase mask."));
      return;
    }
    if (this.editor) this.cancelEditor();
    if (this.isSlideshowActive(panel.id)) this.stopSlideshow(panel);
    const saved = this.maskCache.get(panel.media.selectedId) ?? null;
    const working = saved
      ? cloneEraseMaskCanvas(saved.canvas)
      : createEraseMaskCanvas(dimensions.width, dimensions.height);
    this.editor = {
      panelId: panel.id,
      path: panel.media.selectedId,
      canvas: working,
      saved,
      brushSize: 0.05,
      blur: saved?.blur ?? 0,
      erase: true,
      previousPoint: null,
      applying: false,
      autoMaskBusy: ["queued", "running"].includes(this.autoMaskStatus(panel.media.selectedId)),
    };
    view.beginMaskEditor(working, this.editor);
    if (this.editor.autoMaskBusy) {
      this.pollAutoMask(this.editor.path).catch((error) => {
        this.onError?.(new Error(`Could not monitor auto mask status: ${error.message}`));
      });
    }
  }

  draw(panelId, phase, uv) {
    const editor = this.editor;
    if (!editor || editor.panelId !== panelId || editor.applying || editor.autoMaskBusy) return;
    if (this.getPanel(panelId)?.media.selectedId !== editor.path) {
      this.cancelEditor({ restore: false });
      return;
    }
    if (phase === "start") {
      editor.previousPoint = uv;
      paintEraseStroke(editor.canvas, uv, uv, editor.brushSize, editor.erase ? "erase" : "restore");
    } else if (phase === "update") {
      const previous = editor.previousPoint ?? uv;
      paintEraseStroke(editor.canvas, previous, uv, editor.brushSize, editor.erase ? "erase" : "restore");
      editor.previousPoint = uv;
    } else if (phase === "end") {
      editor.previousPoint = null;
    }
    this.getPanelView(panelId)?.updateMaskEditor(editor.canvas, editor);
  }

  editorAction(panel, action) {
    const editor = this.editor;
    if (!editor || editor.panelId !== panel.id || editor.applying) return;
    if (action === "mask-auto") {
      const cancelling = editor.autoMaskBusy;
      const operation = cancelling
        ? this.cancelAutoMask(editor)
        : this.startAutoMask(editor);
      operation.catch((error) => {
        const prefix = cancelling ? "Could not cancel auto mask" : "Could not generate auto mask";
        this.onError?.(new Error(`${prefix}: ${error.message}`));
      });
      return;
    }
    if (editor.autoMaskBusy) return;
    if (action === "mask-erase") editor.erase = !editor.erase;
    else if (action === "mask-clear") clearEraseMask(editor.canvas);
    else if (action === "mask-cancel") {
      this.cancelEditor();
      return;
    } else if (action === "mask-apply") {
      this.applyEditor().catch((error) => {
        editor.applying = false;
        this.onError?.(new Error(`Could not save erase mask: ${error.message}`));
      });
      return;
    }
    this.getPanelView(panel.id)?.updateMaskEditor(editor.canvas, editor);
  }

  setEditorSetting(panelId, setting, value) {
    const editor = this.editor;
    if (!editor || editor.panelId !== panelId || editor.applying || editor.autoMaskBusy) return;
    if (setting === "brushSize") editor.brushSize = clampBrushSize(value);
    else if (setting === "blur") editor.blur = clampMaskBlur(value);
    else if (setting === "erase") editor.erase = value !== false;
    else throw new TypeError(`Unknown mask editor setting: ${setting}`);
    this.getPanelView(panelId)?.updateMaskEditor(editor.canvas, editor);
  }

  cancelEditor({ restore = true } = {}) {
    const editor = this.editor;
    if (!editor) return;
    const view = this.getPanelView(editor.panelId);
    view?.endMaskEditor();
    const panel = this.getPanel(editor.panelId);
    if (restore && editor.saved) {
      view?.setMask(editor.saved.canvas, {
        blur: editor.saved.blur,
        enabled: panel?.maskEnabled !== false,
      });
      view?.setMaskAvailable(true);
    } else {
      view?.setMask(null);
      view?.setMaskAvailable(false);
    }
    this.editor = null;
  }

  async applyEditor() {
    const editor = this.editor;
    if (!editor || editor.applying) return;
    if (editor.autoMaskBusy) {
      throw new Error("Auto Mask is still generating. Cancel it before applying manual edits.");
    }
    if (this.getPanel(editor.panelId)?.media.selectedId !== editor.path) {
      this.cancelEditor({ restore: false });
      throw new Error("The panel media changed before the mask could be saved.");
    }
    editor.applying = true;
    if (eraseMaskHasPaint(editor.canvas)) {
      const binaryCanvas = binaryEraseMaskCanvas(editor.canvas);
      const response = await this.api.saveMask(
        editor.path,
        await canvasToPng(binaryCanvas),
        editor.blur,
      );
      this.cacheMask(editor.path, {
        canvas: binaryCanvas,
        blur: clampMaskBlur(response?.blur ?? editor.blur),
      });
    } else {
      await this.api.deleteMask(editor.path);
      this.maskCache.delete(editor.path);
    }
    this.maskVersions.set(editor.path, (this.maskVersions.get(editor.path) ?? 0) + 1);
    const path = editor.path;
    this.getPanelView(editor.panelId)?.endMaskEditor();
    this.editor = null;
    this.applyCachedMaskToMatchingPanels(path);
  }

  applyCachedMaskToMatchingPanels(path) {
    const record = this.maskCache.get(path);
    for (const panel of this.getPanels()) {
      if (panel.media.selectedId !== path) continue;
      const view = this.getPanelView(panel.id);
      if (!view) continue;
      if (record) {
        view.setMask(record.canvas, { blur: record.blur, enabled: panel.maskEnabled !== false });
        view.setMaskAvailable(true);
      } else {
        view.setMask(null);
        view.setMaskAvailable(false);
      }
    }
  }

  cacheMask(path, record) {
    this.maskCache.delete(path);
    this.maskCache.set(path, record);
    if (this.maskCache.size <= MAX_CACHED_MASKS) return;
    const retained = new Set(this.getPanels().map((panel) => panel.media.selectedId).filter(Boolean));
    if (this.editor?.path) retained.add(this.editor.path);
    for (const cachedPath of this.maskCache.keys()) {
      if (this.maskCache.size <= MAX_CACHED_MASKS) break;
      if (!retained.has(cachedPath)) this.maskCache.delete(cachedPath);
    }
  }

  async pollAdm(path) {
    if (this.autoAdmPollers.has(path)) return;
    let cancelled = false;
    this.autoAdmPollers.set(path, () => {
      cancelled = true;
    });
    while (!cancelled) {
      const state = await this.api.admStatus(path);
      if (cancelled) break;
      this.autoAdmStates.set(path, state);
      const status = state?.status ?? "idle";
      this.updatePanelsForMediaAdm(path, {});
      if (status === "completed") {
        for (const panel of this.getPanels().filter((item) => item.media.selectedId === path)) {
          const generation = this.getMediaGeneration(panel.id);
          const depth = await this.loadDepthForPath(path, panel.id, generation);
          if (!depth) continue;
          this.getPanelView(panel.id)?.setDepthMap(depth.canvas);
          this.getPanelView(panel.id)?.setAdmState({
            enabled: panel.admEnabled,
            intensity: panel.depthIntensity,
            busy: false,
          });
          this.loadMaskForPanel(panel.id, { path }, generation).catch((error) => {
            this.onError?.(new Error(`Could not refresh ADM mask: ${error.message}`));
          });
        }
        break;
      }
      if (["failed", "cancelled", "idle"].includes(status)) {
        if (status === "failed") {
          const detail = state?.mask?.error ?? state?.depth?.error ?? "Unknown error";
          this.onError?.(new Error(`ADM generation failed: ${detail}`));
        }
        break;
      }
      await this.delay(AUTO_ADM_POLL_INTERVAL_MS);
    }
    this.autoAdmPollers.delete(path);
    this.updatePanelsForMediaAdm(path, {});
  }

  autoMaskStatus(path) {
    return this.autoMaskStates.get(path)?.status ?? "idle";
  }

  setAutoMaskState(path, state) {
    const next = {
      path,
      status: typeof state?.status === "string" ? state.status : "idle",
      requested_at: state?.requested_at ?? null,
      started_at: state?.started_at ?? null,
      completed_at: state?.completed_at ?? null,
      updated_at: state?.updated_at ?? null,
      error: state?.error ?? null,
      device: state?.device ?? null,
      mask: state?.mask ?? null,
    };
    this.autoMaskStates.set(path, next);
    const editor = this.editor;
    if (!editor || editor.path !== path) return;
    editor.autoMaskBusy = ["queued", "running"].includes(next.status);
    this.getPanelView(editor.panelId)?.updateMaskEditor(editor.canvas, editor);
  }

  cancelPendingAutoMaskPoll(path) {
    const stopPolling = this.autoMaskPollers.get(path);
    if (stopPolling) {
      stopPolling();
      this.autoMaskPollers.delete(path);
    }
  }

  nextAutoMaskGeneration(path) {
    const generation = (this.autoMaskGeneration.get(path) ?? 0) + 1;
    this.autoMaskGeneration.set(path, generation);
    return generation;
  }

  async startAutoMask(editor) {
    const generation = this.nextAutoMaskGeneration(editor.path);
    this.cancelPendingAutoMaskPoll(editor.path);
    const response = await this.api.requestAutoMask(editor.path);
    if ((this.autoMaskGeneration.get(editor.path) ?? 0) !== generation) return;
    this.setAutoMaskState(editor.path, response);
    await this.pollAutoMask(editor.path, generation);
  }

  async cancelAutoMask(editor) {
    const generation = this.nextAutoMaskGeneration(editor.path);
    this.cancelPendingAutoMaskPoll(editor.path);
    const response = await this.api.cancelAutoMask(editor.path);
    if ((this.autoMaskGeneration.get(editor.path) ?? 0) !== generation) return;
    this.setAutoMaskState(editor.path, response);
  }

  async pollAutoMask(path, generation = this.autoMaskGeneration.get(path) ?? 0) {
    if (this.autoMaskPollers.has(path)) return;
    let cancelled = false;
    this.autoMaskPollers.set(path, () => {
      cancelled = true;
    });
    try {
      while (!cancelled) {
        if ((this.autoMaskGeneration.get(path) ?? generation) !== generation) break;
        const state = await this.api.autoMaskStatus(path);
        if (cancelled || (this.autoMaskGeneration.get(path) ?? generation) !== generation) break;
        this.setAutoMaskState(path, state);
        const status = state?.status ?? "idle";
        if (status === "completed") {
          await this.reloadAutoMask(path, generation);
          break;
        }
        if (["failed", "cancelled", "idle"].includes(status)) {
          if (status === "failed") {
            this.onError?.(new Error(`Auto mask failed: ${state?.error || "Unknown error"}`));
          }
          break;
        }
        await this.delay(AUTO_MASK_POLL_INTERVAL_MS);
      }
    } finally {
      this.autoMaskPollers.delete(path);
    }
  }

  async reloadAutoMask(path, generation = this.autoMaskGeneration.get(path) ?? 0) {
    if ((this.autoMaskGeneration.get(path) ?? 0) !== generation) return;
    let info = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        info = await this.api.maskInfo(path);
      } catch {
        info = null;
      }
      if (info?.exists) break;
      await this.delay(200);
    }
    if (!info?.exists) return;
    const panels = this.getPanels().filter((panel) => panel.media.selectedId === path);
    let loaded = false;
    let lastError = null;
    for (let attempt = 0; attempt < 5 && !loaded; attempt += 1) {
      if ((this.autoMaskGeneration.get(path) ?? 0) !== generation) return;
      for (const panel of panels) {
        const currentGeneration = this.getMediaGeneration(panel.id);
        try {
          await this.loadMaskForPanel(panel.id, { path }, currentGeneration);
        } catch (error) {
          lastError = error;
        }
      }
      loaded = this.maskCache.has(path);
      if (!loaded) await this.delay(180);
    }
    if (!loaded && lastError) throw lastError;
    const editor = this.editor;
    if (editor?.path !== path) return;
    const record = this.maskCache.get(path);
    if (!record) return;
    editor.canvas = cloneEraseMaskCanvas(record.canvas);
    editor.blur = record.blur;
    editor.autoMaskBusy = false;
    this.getPanelView(editor.panelId)?.updateMaskEditor(editor.canvas, editor);
  }

  stop() {
    if (this.editor) this.cancelEditor();
    for (const stopPolling of this.autoMaskPollers.values()) stopPolling();
    this.autoMaskPollers.clear();
    for (const stopPolling of this.autoAdmPollers.values()) stopPolling();
    this.autoAdmPollers.clear();
  }

  dispose() {
    this.stop();
    this.disposed = true;
    this.maskCache.clear();
    this.depthCache.clear();
  }
}
