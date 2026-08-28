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
import { normalizePowerOfTwoResolution } from "../core/settings.js";

const MAX_CACHED_MASKS = 8;
const AUTO_MASK_POLL_INTERVAL_MS = 550;
const AUTO_ADM_POLL_INTERVAL_MS = 700;

export const LIGHT_DIRECTIONS = Object.freeze(["front", "top", "top-left", "top-right", "left", "right"]);
export const LIGHT_COLORS = Object.freeze(["white", "warm", "cool", "rose", "mint", "gold"]);

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
    this.admSaveQueue = new Map();
    this.admSaveVersion = new Map();
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
        soft_depth_enabled: Boolean(item?.adm?.soft_depth_enabled),
        soft_depth_blur: Number.isFinite(item?.adm?.soft_depth_blur)
          ? Math.min(64, Math.max(2, Number(item.adm.soft_depth_blur)))
          : 12,
        fade_depth_enabled: Boolean(item?.adm?.fade_depth_enabled),
        fade_depth_start: Number.isFinite(item?.adm?.fade_depth_start)
          ? Math.min(1, Math.max(0, Number(item.adm.fade_depth_start)))
          : 0.5,
        focus_blur_enabled: Boolean(item?.adm?.focus_blur_enabled),
        focus_position: ["middle", "back", "front"].includes(item?.adm?.focus_position)
          ? item.adm.focus_position
          : "middle",
        focus_strength: ["middle", "weak", "strong"].includes(item?.adm?.focus_strength)
          ? item.adm.focus_strength
          : "middle",
        light_fx_enabled: Boolean(item?.adm?.light_fx_enabled),
        light_direction: LIGHT_DIRECTIONS.includes(item?.adm?.light_direction)
          ? item.adm.light_direction
          : "front",
        light_color: LIGHT_COLORS.includes(item?.adm?.light_color)
          ? item.adm.light_color
          : "white",
        ambient_color: LIGHT_COLORS.includes(item?.adm?.ambient_color)
          ? item.adm.ambient_color
          : "white",
        ambient_intensity: Number.isFinite(item?.adm?.ambient_intensity)
          ? Math.min(1, Math.max(0, Number(item.adm.ambient_intensity)))
          : 0.5,
      });
    }
  }

  defaultDepthIntensity() {
    const value = this.getSettings()?.admDefaultDepthIntensity;
    return Number.isFinite(value) ? value : 0.35;
  }

  autoGenerationResolution() {
    return normalizePowerOfTwoResolution(this.getSettings()?.admMaxResolution);
  }

  resolveDepthIntensity(adm) {
    return adm?.enabled && Number.isFinite(adm.depth_intensity)
      ? adm.depth_intensity
      : this.defaultDepthIntensity();
  }

  resolveAdmLookup(path, fallback = {}) {
    return this.mediaAdmLookup.get(path) ?? {
      enabled: Boolean(fallback.enabled),
      depth_intensity: Number.isFinite(fallback.depth_intensity) ? fallback.depth_intensity : this.defaultDepthIntensity(),
      soft_depth_enabled: Boolean(fallback.soft_depth_enabled),
      soft_depth_blur: Number.isFinite(fallback.soft_depth_blur) ? fallback.soft_depth_blur : 12,
      fade_depth_enabled: Boolean(fallback.fade_depth_enabled),
      fade_depth_start: Number.isFinite(fallback.fade_depth_start) ? fallback.fade_depth_start : 0.5,
      focus_blur_enabled: Boolean(fallback.focus_blur_enabled),
      focus_position: ["middle", "back", "front"].includes(fallback.focus_position) ? fallback.focus_position : "middle",
      focus_strength: ["middle", "weak", "strong"].includes(fallback.focus_strength) ? fallback.focus_strength : "middle",
      light_fx_enabled: Boolean(fallback.light_fx_enabled),
      light_direction: LIGHT_DIRECTIONS.includes(fallback.light_direction) ? fallback.light_direction : "front",
      light_color: LIGHT_COLORS.includes(fallback.light_color) ? fallback.light_color : "white",
      ambient_color: LIGHT_COLORS.includes(fallback.ambient_color) ? fallback.ambient_color : "white",
      ambient_intensity: Number.isFinite(fallback.ambient_intensity) ? fallback.ambient_intensity : 0.5,
    };
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
    const [displayBlob, binaryBlob] = await Promise.all([
      this.api.loadMask(item.path, "display"),
      this.api.loadMask(item.path, "binary"),
    ]);
    if (!this.isCurrentMediaRequest(panelId, item.path, generation)
      || (this.maskVersions.get(item.path) ?? 0) !== maskVersion) return;
    const dimensions = view.getMediaDimensions();
    if (!dimensions) return;
    const [displayCanvas, binaryCanvas] = await Promise.all([
      this.canvasFromBlob(displayBlob, dimensions, createEraseMaskCanvas),
      this.canvasFromBlob(binaryBlob, dimensions, createEraseMaskCanvas),
    ]);
    if (!this.isCurrentMediaRequest(panelId, item.path, generation)
      || (this.maskVersions.get(item.path) ?? 0) !== maskVersion) return;
    const record = {
      displayCanvas,
      editorCanvas: binaryCanvas,
      blur: clampMaskBlur(info.blur),
    };
    this.cacheMask(item.path, record);
    const panel = this.getPanel(panelId);
    view.setMask(record.displayCanvas, { blur: record.blur, enabled: panel?.maskEnabled !== false });
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
        soft_depth_enabled: Boolean(adm?.soft_depth_enabled),
        soft_depth_blur: Number.isFinite(adm?.soft_depth_blur)
          ? Math.min(64, Math.max(2, Number(adm.soft_depth_blur)))
          : 12,
        fade_depth_enabled: Boolean(adm?.fade_depth_enabled),
        fade_depth_start: Number.isFinite(adm?.fade_depth_start)
          ? Math.min(1, Math.max(0, Number(adm.fade_depth_start)))
          : 0.5,
        focus_blur_enabled: Boolean(adm?.focus_blur_enabled),
        focus_position: ["middle", "back", "front"].includes(adm?.focus_position)
          ? adm.focus_position
          : "middle",
        focus_strength: ["middle", "weak", "strong"].includes(adm?.focus_strength)
          ? adm.focus_strength
          : "middle",
        light_fx_enabled: Boolean(adm?.light_fx_enabled),
        light_direction: LIGHT_DIRECTIONS.includes(adm?.light_direction) ? adm.light_direction : "front",
        light_color: LIGHT_COLORS.includes(adm?.light_color) ? adm.light_color : "white",
        ambient_color: LIGHT_COLORS.includes(adm?.ambient_color) ? adm.ambient_color : "white",
        ambient_intensity: Number.isFinite(adm?.ambient_intensity)
          ? Math.min(1, Math.max(0, Number(adm.ambient_intensity)))
          : 0.5,
      });
    }
    if (!this.isCurrentMediaRequest(panelId, path, generation)) return;
    const enabled = Boolean(adm?.enabled);
    const intensity = this.resolveDepthIntensity(adm);
    const record = this.resolveAdmLookup(path, adm);
    this.setAdmEnabled(panelId, enabled);
    this.setDepthIntensity(panelId, intensity);
    view.setAdmState({
      enabled,
      intensity,
      softDepthEnabled: record.soft_depth_enabled,
      softDepthBlur: record.soft_depth_blur,
      fadeDepthEnabled: record.fade_depth_enabled,
      fadeDepthStart: record.fade_depth_start,
      focusBlurEnabled: record.focus_blur_enabled,
      focusPosition: record.focus_position,
      focusStrength: record.focus_strength,
      lightFxEnabled: record.light_fx_enabled,
      lightDirection: record.light_direction,
      lightColor: record.light_color,
      ambientColor: record.ambient_color,
      ambientIntensity: record.ambient_intensity,
      busy: this.autoAdmBusy(path),
    });
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
      gridSegments: normalizePowerOfTwoResolution(this.getSettings()?.admMaxResolution),
    };
    const record = { canvas, updated_at: info.updated_at ?? null };
    this.depthCache.set(path, record);
    return record;
  }

  updatePanelsForMediaAdm(path, {
    enabled,
    depthIntensity,
    softDepthEnabled,
    softDepthBlur,
    fadeDepthEnabled,
    fadeDepthStart,
    focusBlurEnabled,
    focusPosition,
    focusStrength,
    lightFxEnabled,
    lightDirection,
    lightColor,
    ambientColor,
    ambientIntensity,
  } = {}) {
    const current = this.resolveAdmLookup(path, {
      enabled: false,
      depth_intensity: this.defaultDepthIntensity(),
    });
    const next = {
      enabled: enabled == null ? current.enabled : Boolean(enabled),
      depth_intensity: Number.isFinite(depthIntensity) ? depthIntensity : current.depth_intensity,
      soft_depth_enabled: softDepthEnabled == null ? current.soft_depth_enabled : Boolean(softDepthEnabled),
      soft_depth_blur: Number.isFinite(softDepthBlur) ? Math.min(64, Math.max(2, Number(softDepthBlur))) : current.soft_depth_blur,
      fade_depth_enabled: fadeDepthEnabled == null ? current.fade_depth_enabled : Boolean(fadeDepthEnabled),
      fade_depth_start: Number.isFinite(fadeDepthStart) ? Math.min(1, Math.max(0, Number(fadeDepthStart))) : current.fade_depth_start,
      focus_blur_enabled: focusBlurEnabled == null ? current.focus_blur_enabled : Boolean(focusBlurEnabled),
      focus_position: ["middle", "back", "front"].includes(focusPosition) ? focusPosition : current.focus_position,
      focus_strength: ["middle", "weak", "strong"].includes(focusStrength) ? focusStrength : current.focus_strength,
      light_fx_enabled: lightFxEnabled == null ? current.light_fx_enabled : Boolean(lightFxEnabled),
      light_direction: LIGHT_DIRECTIONS.includes(lightDirection) ? lightDirection : current.light_direction,
      light_color: LIGHT_COLORS.includes(lightColor) ? lightColor : current.light_color,
      ambient_color: LIGHT_COLORS.includes(ambientColor) ? ambientColor : current.ambient_color,
      ambient_intensity: Number.isFinite(ambientIntensity) ? Math.min(1, Math.max(0, Number(ambientIntensity))) : current.ambient_intensity,
    };
    this.mediaAdmLookup.set(path, next);
    for (const [panelId, runtime] of this.getRuntimes()) {
      for (const item of runtime.playlist) {
        if (item.path === path) item.adm = {
          enabled: next.enabled,
          depth_intensity: next.depth_intensity,
          soft_depth_enabled: next.soft_depth_enabled,
          soft_depth_blur: next.soft_depth_blur,
          fade_depth_enabled: next.fade_depth_enabled,
          fade_depth_start: next.fade_depth_start,
          focus_blur_enabled: next.focus_blur_enabled,
          focus_position: next.focus_position,
          focus_strength: next.focus_strength,
          light_fx_enabled: next.light_fx_enabled,
          light_direction: next.light_direction,
          light_color: next.light_color,
          ambient_color: next.ambient_color,
          ambient_intensity: next.ambient_intensity,
        };
      }
      const panel = this.getPanel(panelId);
      if (!panel || panel.media.selectedId !== path) continue;
      this.setAdmEnabled(panel.id, next.enabled);
      this.setDepthIntensity(panel.id, next.depth_intensity);
      const view = this.getPanelView(panel.id);
      view?.setAdmState({
        enabled: next.enabled,
        intensity: next.depth_intensity,
        softDepthEnabled: next.soft_depth_enabled,
        softDepthBlur: next.soft_depth_blur,
        fadeDepthEnabled: next.fade_depth_enabled,
        fadeDepthStart: next.fade_depth_start,
        focusBlurEnabled: next.focus_blur_enabled,
        focusPosition: next.focus_position,
        focusStrength: next.focus_strength,
        lightFxEnabled: next.light_fx_enabled,
        lightDirection: next.light_direction,
        lightColor: next.light_color,
        ambientColor: next.ambient_color,
        ambientIntensity: next.ambient_intensity,
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
    this.getPanelView(panel.id)?.setMask(record.displayCanvas, {
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
    const state = await this.api.requestAdm(path, this.autoGenerationResolution());
    this.autoAdmStates.set(path, state);
    await this.pollAdm(path);
  }

  async deleteDepth(panel) {
    const path = panel.media.selectedId;
    const view = this.getPanelView(panel.id);
    if (!path || !view || view.mediaType !== "image") {
      throw new Error("Select an image before deleting depth data.");
    }
    await this.api.deleteDepth(path);
    this.depthCache.delete(path);
    await this.saveMediaAdm(path, { enabled: false, depthIntensity: panel.depthIntensity });
  }

  cancelAdmGeneration(panel) {
    this.getPanelView(panel.id)?.hideAdmPrompt();
  }

  async saveMediaAdm(path, {
    enabled,
    depthIntensity,
    softDepthEnabled,
    softDepthBlur,
    fadeDepthEnabled,
    fadeDepthStart,
    focusBlurEnabled,
    focusPosition,
    focusStrength,
    lightFxEnabled,
    lightDirection,
    lightColor,
    ambientColor,
    ambientIntensity,
  }) {
    const nextVersion = (this.admSaveVersion.get(path) ?? 0) + 1;
    this.admSaveVersion.set(path, nextVersion);
    const previous = this.admSaveQueue.get(path) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        const saved = await this.api.saveMediaAdm(path, enabled, depthIntensity, {
          soft_depth_enabled: softDepthEnabled,
          soft_depth_blur: softDepthBlur,
          fade_depth_enabled: fadeDepthEnabled,
          fade_depth_start: fadeDepthStart,
          focus_blur_enabled: focusBlurEnabled,
          focus_position: focusPosition,
          focus_strength: focusStrength,
          light_fx_enabled: lightFxEnabled,
          light_direction: lightDirection,
          light_color: lightColor,
          ambient_color: ambientColor,
          ambient_intensity: ambientIntensity,
        });
        if (this.admSaveVersion.get(path) !== nextVersion) return;
        this.updatePanelsForMediaAdm(path, {
          enabled: saved?.enabled ?? enabled,
          depthIntensity: saved?.depth_intensity ?? depthIntensity,
          softDepthEnabled: saved?.soft_depth_enabled ?? softDepthEnabled,
          softDepthBlur: saved?.soft_depth_blur ?? softDepthBlur,
          fadeDepthEnabled: saved?.fade_depth_enabled ?? fadeDepthEnabled,
          fadeDepthStart: saved?.fade_depth_start ?? fadeDepthStart,
          focusBlurEnabled: saved?.focus_blur_enabled ?? focusBlurEnabled,
          focusPosition: saved?.focus_position ?? focusPosition,
          focusStrength: saved?.focus_strength ?? focusStrength,
          lightFxEnabled: saved?.light_fx_enabled ?? lightFxEnabled,
          lightDirection: saved?.light_direction ?? lightDirection,
          lightColor: saved?.light_color ?? lightColor,
          ambientColor: saved?.ambient_color ?? ambientColor,
          ambientIntensity: saved?.ambient_intensity ?? ambientIntensity,
        });
      });
    this.admSaveQueue.set(path, task);
    return task.finally(() => {
      if (this.admSaveQueue.get(path) === task) this.admSaveQueue.delete(path);
    });
  }

  setAdmSetting(panelId, setting, value) {
    const panel = this.getPanel(panelId);
    if (!panel || !panel.media.selectedId) return;
    const record = this.resolveAdmLookup(panel.media.selectedId, panel);
    const next = {
      enabled: panel.admEnabled,
      depthIntensity: panel.depthIntensity,
      softDepthEnabled: record.soft_depth_enabled,
      softDepthBlur: record.soft_depth_blur,
      fadeDepthEnabled: record.fade_depth_enabled,
      fadeDepthStart: record.fade_depth_start,
      focusBlurEnabled: record.focus_blur_enabled,
      focusPosition: record.focus_position,
      focusStrength: record.focus_strength,
      lightFxEnabled: record.light_fx_enabled,
      lightDirection: record.light_direction,
      lightColor: record.light_color,
      ambientColor: record.ambient_color,
      ambientIntensity: record.ambient_intensity,
    };
    if (setting === "depthIntensity") next.depthIntensity = value;
    else if (setting === "softDepthEnabled") next.softDepthEnabled = Boolean(value);
    else if (setting === "softDepthBlur") next.softDepthBlur = Number(value);
    else if (setting === "fadeDepthEnabled") next.fadeDepthEnabled = Boolean(value);
    else if (setting === "fadeDepthStart") next.fadeDepthStart = Number(value);
    else if (setting === "focusBlurEnabled") next.focusBlurEnabled = Boolean(value);
    else if (setting === "focusPosition") next.focusPosition = value;
    else if (setting === "focusStrength") next.focusStrength = value;
    else if (setting === "lightFxEnabled") next.lightFxEnabled = Boolean(value);
    else if (setting === "lightDirection") next.lightDirection = value;
    else if (setting === "lightColor") next.lightColor = value;
    else if (setting === "ambientColor") next.ambientColor = value;
    else if (setting === "ambientIntensity") next.ambientIntensity = Number(value);
    else throw new TypeError(`Unknown ADM setting: ${setting}`);
    this.updatePanelsForMediaAdm(panel.media.selectedId, {
      enabled: next.enabled,
      depthIntensity: next.depthIntensity,
      softDepthEnabled: next.softDepthEnabled,
      softDepthBlur: next.softDepthBlur,
      fadeDepthEnabled: next.fadeDepthEnabled,
      fadeDepthStart: next.fadeDepthStart,
      focusBlurEnabled: next.focusBlurEnabled,
      focusPosition: next.focusPosition,
      focusStrength: next.focusStrength,
      lightFxEnabled: next.lightFxEnabled,
      lightDirection: next.lightDirection,
      lightColor: next.lightColor,
      ambientColor: next.ambientColor,
      ambientIntensity: next.ambientIntensity,
    });
    this.saveMediaAdm(panel.media.selectedId, next).catch((error) => {
      this.onError?.(new Error(`Could not save ADM setting: ${error.message}`));
    });
  }

  flushAdmSettingsForPanel(panelId) {
    const panel = this.getPanel(panelId);
    if (!panel?.media?.selectedId) return Promise.resolve();
    const path = panel.media.selectedId;
    const record = this.resolveAdmLookup(path, panel);
    const next = {
      enabled: Boolean(panel.admEnabled),
      depthIntensity: this.resolveDepthIntensity(panel),
      softDepthEnabled: record.soft_depth_enabled,
      softDepthBlur: record.soft_depth_blur,
      fadeDepthEnabled: record.fade_depth_enabled,
      fadeDepthStart: record.fade_depth_start,
      focusBlurEnabled: record.focus_blur_enabled,
      focusPosition: record.focus_position,
      focusStrength: record.focus_strength,
      lightFxEnabled: record.light_fx_enabled,
      lightDirection: record.light_direction,
      lightColor: record.light_color,
      ambientColor: record.ambient_color,
      ambientIntensity: record.ambient_intensity,
    };
    return this.saveMediaAdm(path, next).catch((error) => {
      this.onError?.(new Error(`Could not save ADM setting: ${error.message}`));
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
      ? cloneEraseMaskCanvas(saved.editorCanvas)
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
      view?.setMask(editor.saved.displayCanvas, {
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
      const dimensions = this.getPanelView(editor.panelId)?.getMediaDimensions();
      if (!dimensions) throw new Error("Mask could not be refreshed because panel dimensions were unavailable.");
      const [displayBlob, binaryBlob] = await Promise.all([
        this.api.loadMask(editor.path, "display"),
        this.api.loadMask(editor.path, "binary"),
      ]);
      const [displayCanvas, editorCanvas] = await Promise.all([
        this.canvasFromBlob(displayBlob, dimensions, createEraseMaskCanvas),
        this.canvasFromBlob(binaryBlob, dimensions, createEraseMaskCanvas),
      ]);
      this.cacheMask(editor.path, {
        displayCanvas,
        editorCanvas,
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
        view.setMask(record.displayCanvas, { blur: record.blur, enabled: panel.maskEnabled !== false });
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
    const response = await this.api.requestAutoMask(editor.path, this.autoGenerationResolution());
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
    editor.canvas = cloneEraseMaskCanvas(record.editorCanvas);
    editor.blur = record.blur;
    editor.autoMaskBusy = false;
    this.getPanelView(editor.panelId)?.updateMaskEditor(editor.canvas, editor);
    for (const panel of panels) {
      this.setMaskEnabled(panel.id, true);
      this.getPanelView(panel.id)?.setMask(record.displayCanvas, { blur: record.blur, enabled: true });
    }
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
    this.admSaveQueue.clear();
    this.admSaveVersion.clear();
    this.maskCache.clear();
    this.depthCache.clear();
  }
}
