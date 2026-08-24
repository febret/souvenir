import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import {
  PanelStore,
  applyPanelGesture,
  createPersistentRandomSeed,
  createSlideshowState,
  createEraseMaskCanvas,
  binaryEraseMaskCanvas,
  cloneEraseMaskCanvas,
  clearEraseMask,
  canvasToPng,
  dimensionsForAspectRatio,
  eraseMaskHasPaint,
  mediaId,
  normalizeMediaEntry,
  nextAspectRatioMode,
  nextDisplayMode,
  nextMedia,
  paintEraseStroke,
  playbackPolicy,
  previousMedia,
  slideshowTransition,
  sortMedia,
  clampBrushSize,
  clampMaskBlur,
  DEFAULT_ENVIRONMENT_MODE,
  createCommentaryVolumeController,
  normalizeEnvironmentMode,
  normalizeCommentaryVolume,
  matchesTagFilter,
  normalizeTagDefinitions,
  normalizeTagIds,
  aggregatePanelTagCounts,
  captionAtTime,
  parseCaptionTimeline,
  scoreCommentary,
  selectCommentary,
} from "../core/index.js";
import { EnvironmentEffects } from "./environment-effects.js";
import { InteractionController } from "./interaction-controller.js";
import { loadLayout, saveLayout, validateLibraryId } from "./layout-storage.js";
import { MediaBrowserView } from "./media-browser-view.js";
import { PanelView } from "./panel-view.js";
import { SpatialToolbar } from "./spatial-toolbar.js";
import { createPreviewEnvironment } from "./environment.js";
import { disposeObject } from "./canvas-ui.js";
import { CaptionView } from "./caption-view.js";

const DEFAULT_PANEL_POSITION = { x: 0, y: 1.35, z: -1.45 };
const PANEL_DIMENSION_LIMITS = Object.freeze({ minHeight: 0.15, maxHeight: 5 });
const MAX_CACHED_MASKS = 8;

function tagDefinitions(payload) {
  const values = Array.isArray(payload) ? payload : payload?.tags ?? payload?.definitions ?? [];
  return normalizeTagDefinitions(values);
}

function tagIdsFromResponse(payload) {
  return normalizeTagIds(
    Array.isArray(payload) ? payload : payload?.tag_ids ?? payload?.tagIds ?? payload?.tags,
  );
}

function normalizedCommentaryEntries(payload) {
  const values = Array.isArray(payload)
    ? payload
    : payload?.entries ?? payload?.items ?? payload?.commentary ?? payload?.sounds ?? [];
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((entry) => {
      const path = String(entry?.path ?? entry?.file_path ?? entry?.filePath ?? "").trim();
      return {
        ...entry,
        path,
        name: String(entry?.name ?? path.split("/").at(-1) ?? "").trim(),
        caption: typeof entry?.caption === "string" ? entry.caption : "",
        volume: normalizeCommentaryVolume(entry?.volume),
        tag_ids: normalizeTagIds(
          entry?.tag_ids
          ?? entry?.tagIds
          ?? (Array.isArray(entry?.tags) ? entry.tags.map((tag) => tag?.id ?? tag) : entry?.tags),
        ),
      };
    })
    .filter((entry) => entry.path && !seen.has(entry.path) && seen.add(entry.path));
}

function layoutRuntime(value = {}) {
  return {
    playlist: Array.isArray(value.playlist) ? value.playlist.map(normalizeMediaEntry) : [],
    slideshow: createSlideshowState(value.slideshow ?? {}),
  };
}

async function maskCanvasFromBlob(blob, dimensions) {
  const bitmap = await createImageBitmap(blob);
  const canvas = createEraseMaskCanvas(dimensions.width, dimensions.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas;
}

export class SpatialApp {
  constructor({ canvas, api, settings, storage, libraryId, onExit, onError }) {
    this.canvas = canvas;
    this.api = api;
    this.getSettings = settings;
    this.storage = storage;
    this.libraryId = validateLibraryId(libraryId);
    this.onExit = onExit;
    this.onError = onError;
    this.panelViews = new Map();
    this.runtime = new Map();
    this.loadedMedia = new Map();
    this.mediaGenerations = new Map();
    this.maskVersions = new Map();
    this.maskCache = new Map();
    this.maskEditor = null;
    this.tagDefinitions = [];
    this.playlistGenerations = new Map();
    this.mediaTagLookup = new Map();
    this.commentaryEntries = [];
    this.commentaryScores = [];
    this.commentaryPath = null;
    this.commentaryAvailable = false;
    this.commentaryEnabled = false;
    this.commentaryPlaying = false;
    this.commentaryAudio = null;
    this.commentaryAudioVolume = null;
    this.commentaryPlaybackGeneration = 0;
    this.commentaryCaptionTimeline = [];
    this.commentaryDisposed = false;
    this.onCommentaryEnded = () => {
      if (!this.commentaryEnabled || this.commentaryDisposed) return;
      this.#playCommentary().catch((error) => this.#failCommentary(error));
    };
    this.onCommentaryError = () => {
      if (!this.commentaryEnabled || this.commentaryDisposed) return;
      this.#failCommentary(new Error("The commentary audio could not be played."));
    };
    this.saveTimer = null;
    this.running = false;
    this.immersive = false;
    this.environmentMode = DEFAULT_ENVIRONMENT_MODE;
    this.environmentBlendMode = "unknown";
    this.#initializeScene();
    this.#initializeState();
  }

  #initializeScene() {
    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 100);
    this.camera.position.set(0, 1.45, 1.35);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType("local-floor");
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));

    this.previewEnvironment = createPreviewEnvironment();
    this.scene.add(this.previewEnvironment);

    this.environmentEffects = new EnvironmentEffects(this.environmentMode);
    this.environmentEffectScene = this.environmentEffects.scene;
    this.environmentEffectMaterial = this.environmentEffects.material;
    this.scene.userData.environmentEffects = this.environmentEffects.metadata;

    this.toolbar = new SpatialToolbar({ environmentMode: this.environmentMode });
    this.toolbar.position.set(0, 0.82, -1.25);
    this.scene.add(this.toolbar);
    this.captionView = new CaptionView();
    this.scene.add(this.captionView);

    this.interactions = new InteractionController({
      renderer: this.renderer,
      camera: this.camera,
      scene: this.scene,
      canvas: this.canvas,
      onActivate: (hit) => this.#activate(hit),
      onGesture: (target, gesture) => this.#gesture(target, gesture),
      onFocus: (target) => this.#focus(target),
    });

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(0, 1.2, -1.3);
    this.controls.enableDamping = true;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 5;

    this.onResize = () => this.#resize();
    window.addEventListener("resize", this.onResize);
    this.#resize();
  }

  #initializeState() {
    let saved = {
      panels: [],
      focusedId: null,
      runtime: {},
      environmentMode: DEFAULT_ENVIRONMENT_MODE,
      libraryId: this.libraryId,
    };
    try {
      saved = loadLayout(this.storage, this.libraryId);
    } catch (error) {
      this.onError?.(error);
      this.storage.removeItem("souvenir.layout.v1");
    }
    this.store = new PanelStore({
      panels: saved.panels,
      focusedId: saved.focusedId,
    });
    for (const [panelId, value] of Object.entries(saved.runtime)) {
      this.runtime.set(panelId, layoutRuntime(value));
    }
    this.setEnvironmentMode(saved.environmentMode, { persist: false });
    if (this.store.getState().panels.length === 0) {
      this.store.add({ transform: { position: DEFAULT_PANEL_POSITION } });
    }
    this.unsubscribe = this.store.subscribe((state) => this.#syncState(state));
    this.#syncState(this.store.getState());
  }

  async start({ immersive }) {
    this.immersive = immersive;
    this.running = true;
    this.previewEnvironment.visible = !immersive;
    this.controls.enabled = !immersive;
    try {
      await this.#refreshTagDefinitions();
    } catch (error) {
      this.onError?.(new Error(`Could not refresh tag definitions: ${error.message}`));
    }
    try {
      await this.#refreshCommentary();
    } catch (error) {
      this.commentaryEntries = [];
      this.commentaryAvailable = false;
      this.#disableCommentary();
      this.onError?.(new Error(`Could not refresh commentary: ${error.message}`));
    }

    if (immersive) {
      if (!navigator.xr) {
        throw new Error("WebXR is not available in this browser.");
      }
      const session = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: ["local-floor"],
        optionalFeatures: ["hand-tracking"],
      });
      session.addEventListener("end", () => {
        if (this.running) this.onExit?.();
      });
      await this.renderer.xr.setSession(session);
      this.renderer.setClearColor(0x000000, 0);
      this.environmentBlendMode = this.environmentEffects.setEnvironmentBlendMode(
        session.environmentBlendMode,
      );
      this.scene.userData.environmentEffects = this.environmentEffects.metadata;
    }

    this.renderer.setAnimationLoop((time) => this.#render(time));
  }

  stop() {
    this.#disableCommentary();
    if (!this.running) return;
    if (this.maskEditor) this.#cancelMaskEditor();
    this.running = false;
    this.renderer.setAnimationLoop(null);
    const session = this.renderer.xr.getSession();
    if (session) {
      session.end().catch((error) => this.onError?.(error));
    }
    this.#persistNow();
  }

  dispose() {
    this.stop();
    this.commentaryDisposed = true;
    if (this.commentaryAudio) {
      this.commentaryAudio.removeEventListener("ended", this.onCommentaryEnded);
      this.commentaryAudio.removeEventListener("error", this.onCommentaryError);
      this.commentaryAudioVolume?.dispose();
      this.commentaryAudioVolume = null;
      this.#clearCommentaryAudio();
      this.commentaryCaptionTimeline = [];
      this.captionView?.setText("");
      this.commentaryAudio = null;
    }
    window.removeEventListener("resize", this.onResize);
    this.unsubscribe?.();
    this.interactions?.dispose();
    this.controls?.dispose();
    this.browser?.dispose();
    for (const view of this.panelViews.values()) view.dispose();
    this.panelViews.clear();
    this.toolbar?.dispose();
    this.environmentEffects?.dispose();
    this.captionView?.dispose();
    disposeObject(this.previewEnvironment);
    this.renderer?.dispose();
  }

  setEnvironmentMode(mode, { persist = true } = {}) {
    this.environmentMode = normalizeEnvironmentMode(mode);
    this.environmentEffects?.setMode(this.environmentMode);
    this.toolbar?.setEnvironmentMode(this.environmentMode);
    if (persist) this.#scheduleSave();
    return this.environmentMode;
  }

  get currentEnvironmentMode() {
    return this.environmentMode;
  }

  #syncState(state) {
    const panelIds = new Set(state.panels.map((panel) => panel.id));
    for (const [panelId, view] of this.panelViews) {
      if (!panelIds.has(panelId)) {
        view.dispose();
        this.scene.remove(view);
        this.panelViews.delete(panelId);
        this.runtime.delete(panelId);
        this.loadedMedia.delete(panelId);
        this.mediaGenerations.delete(panelId);
        this.playlistGenerations.delete(panelId);
        if (this.maskEditor?.panelId === panelId) this.maskEditor = null;
      }
    }

    for (const panel of state.panels) {
      const runtime = this.#runtimeFor(panel.id);
      runtime.playlist = runtime.playlist.filter((item) => matchesTagFilter(item, panel.tagFilter));
      let view = this.panelViews.get(panel.id);
      if (!view) {
        view = new PanelView(panel, {
          onAction: (panelId, action) => this.#panelAction(panelId, action),
          onTagSelection: (panelId, tagIds) => this.#saveMediaTags(panelId, tagIds),
          onVideoEnded: (panelId) => this.#videoEnded(panelId),
          onMaskDraw: (panelId, phase, uv) => this.#drawMask(panelId, phase, uv),
          onMaskSetting: (panelId, setting, value) => {
            this.#setMaskEditorSetting(panelId, setting, value);
          },
          onError: (error) => this.onError?.(error),
        });
        this.panelViews.set(panel.id, view);
        this.scene.add(view);
      }
      view.applyState({
        ...panel,
        focused: state.focusedId === panel.id,
        slideshow: { playing: runtime.slideshow.active },
      });
      view.setFocused(state.focusedId === panel.id);
      view.setTagDefinitions(this.tagDefinitions);
      const selected = runtime.playlist.find((item) => mediaId(item) === panel.media.selectedId);
      if (selected) this.#rememberMediaTags(selected);
      view.setMediaTagSelection(selected?.tag_ids ?? []);
      if (this.browser?.panelId === panel.id) this.browser.setTagFilter(panel.tagFilter);
      if (
        panel.media.selectedId &&
        this.loadedMedia.get(panel.id) !== panel.media.selectedId
      ) {
        const selected = runtime.playlist.find(
          (item) => mediaId(item) === panel.media.selectedId,
        );
        if (selected) {
          this.#showMedia(panel.id, selected);
        } else {
          this.#restorePlaylist(panel).catch((error) => this.onError?.(error));
        }
      }
    }
    this.#scheduleSave();
  }

  #runtimeFor(panelId) {
    if (!this.runtime.has(panelId)) {
      this.runtime.set(panelId, layoutRuntime());
    }
    return this.runtime.get(panelId);
  }

  async #restorePlaylist(panel) {
    if (!panel.media.directory) return;
    const payload = await this.api.directory(
      panel.media.directory,
      this.getSettings().mediaDirectories,
    );
    const entries = (payload.entries ?? payload.items ?? payload ?? [])
      .filter((entry) => entry.kind !== "directory")
      .map(normalizeMediaEntry)
      .filter((entry) => matchesTagFilter(entry, panel.tagFilter));
    const runtime = this.#runtimeFor(panel.id);
    runtime.playlist = this.#sort(entries, panel.media.sort);
    this.#rememberMediaTags(entries);
    const selected = runtime.playlist.find(
      (item) => mediaId(item) === panel.media.selectedId,
    );
    if (selected) {
      this.panelViews.get(panel.id)?.setMediaTagSelection(selected.tag_ids);
      await this.#showMedia(panel.id, selected);
    } else {
      this.store.setMedia(panel.id, null);
      this.onError?.(
        new Error("A saved media file is no longer available and was cleared."),
      );
    }
  }

  #sort(entries, mode) {
    const seed = createPersistentRandomSeed({ storage: this.storage });
    return sortMedia(entries.map(normalizeMediaEntry), { mode, seed });
  }

  async #showMedia(panelId, item) {
    const view = this.panelViews.get(panelId);
    if (!view) return;
    if (this.maskEditor?.panelId === panelId && this.maskEditor.path !== item.path) {
      this.#cancelMaskEditor({ restore: false });
    }
    const generation = (this.mediaGenerations.get(panelId) ?? 0) + 1;
    this.#rememberMediaTags(item);
    this.mediaGenerations.set(panelId, generation);
    this.loadedMedia.set(panelId, mediaId(item));
    view.setMask(null);
    view.setMaskAvailable(false);
    const runtime = this.#runtimeFor(panelId);
    runtime.slideshow = slideshowTransition(
      runtime.slideshow,
      { type: "set-current", mediaId: mediaId(item), now: performance.now() },
    ).state;
    const policy = playbackPolicy(item, {
      autoplayVideos: this.getSettings().autoplayVideos,
      slideshowActive: runtime.slideshow.active,
    });
    const result = await view.showMedia(
      item,
      item.url ?? item.file_url ?? this.api.fileUrl(item.path),
      policy,
    );
    if (!this.#isCurrentMedia(panelId, item.path, generation)) return;
    const panel = this.#panel(panelId);
    if (!result) {
      if (panel?.media.selectedId === mediaId(item)) this.loadedMedia.delete(panelId);
    } else if (
      result.type === "image" &&
      panel?.media.selectedId === mediaId(item) &&
      panel.aspectRatioMode === "native"
    ) {
      this.#applyAspectRatio(panelId, panel.aspectRatioMode);
    }
    if (result) {
      this.#loadMaskForPanel(panelId, item, generation).catch((error) => {
        if (this.#isCurrentMedia(panelId, item.path, generation)) {
          this.onError?.(new Error(`Could not load erase mask: ${error.message}`));
        }
      });
    }
    this.#scheduleSave();
  }

  #activate(hit) {
    const { object, uv } = hit;
    const { kind, action, panelId } = object.userData;
    if (kind === "button") {
      if (object.userData.tagMenu) {
        object.userData.tagMenu.handleAction(action).catch((error) => this.onError?.(error));
      } else if (object.userData.browser) {
        object.userData.browser?.handleAction(action);
      } else if (panelId) {
        this.#panelAction(panelId, action);
      } else {
        this.#toolbarAction(action);
      }
      return;
    }
    if (kind === "browser-entry") {
      object.userData.browser.activateEntry(object.userData.entry);
      return;
    }
    if (kind === "panel-surface") {
      this.panelViews.get(panelId)?.activateSurface(uv);
    }
  }

  #rememberMediaTags(media) {
    for (const item of Array.isArray(media) ? media : [media]) {
      const path = String(item?.path ?? item?.id ?? "").trim();
      if (path) this.mediaTagLookup.set(path, normalizeTagIds(item?.tag_ids));
    }
  }

  #currentMediaTagLookup() {
    const lookup = new Map(this.mediaTagLookup);
    for (const runtime of this.runtime.values()) {
      this.#rememberMediaTags(runtime.playlist);
    }
    for (const panel of this.store.getState().panels) {
      const selected = this.#runtimeFor(panel.id).playlist.find(
        (item) => mediaId(item) === panel.media.selectedId,
      );
      if (selected) this.#rememberMediaTags(selected);
    }
    for (const [path, tagIds] of this.mediaTagLookup) lookup.set(path, tagIds);
    return lookup;
  }

  #syncCommentaryToolbar() {
    this.toolbar?.setCommentaryState({
      available: this.commentaryAvailable,
      enabled: this.commentaryEnabled,
      playing: this.commentaryPlaying,
    });
  }

  async #refreshCommentary() {
    const entries = normalizedCommentaryEntries(await this.api.commentary());
    this.commentaryEntries = entries;
    this.commentaryAvailable = entries.length > 0;
    if (!this.commentaryAvailable && this.commentaryEnabled) this.#disableCommentary();
    else this.#syncCommentaryToolbar();
    return entries;
  }

  #ensureCommentaryAudio() {
    if (this.commentaryAudio) return this.commentaryAudio;
    const audio = document.createElement("audio");
    audio.preload = "auto";
    audio.addEventListener("ended", this.onCommentaryEnded);
    audio.addEventListener("error", this.onCommentaryError);
    this.commentaryAudio = audio;
    this.commentaryAudioVolume = createCommentaryVolumeController(audio);
    return audio;
  }

  #clearCommentaryAudio() {
    const audio = this.commentaryAudio;
    if (!audio) return;
    audio.pause?.();
    audio.removeAttribute?.("src");
    if (!audio.removeAttribute) audio.src = "";
    audio.load?.();
  }

  #disableCommentary() {
    this.commentaryPlaybackGeneration += 1;
    this.commentaryEnabled = false;
    this.commentaryPlaying = false;
    this.#clearCommentaryAudio();
    this.#syncCommentaryToolbar();
  }

  #failCommentary(error) {
    const detail = error?.message ?? String(error ?? "Unknown audio error.");
    this.#disableCommentary();
    this.onError?.(new Error(`Commentary playback failed: ${detail}`));
  }

  async #toggleCommentary() {
    if (this.commentaryEnabled) {
      this.#disableCommentary();
      return;
    }
    if (!this.commentaryAvailable) {
      this.#syncCommentaryToolbar();
      this.onError?.(new Error("Commentary is unavailable because no commentary files were found."));
      return;
    }
    this.commentaryEnabled = true;
    this.commentaryPlaying = false;
    this.#syncCommentaryToolbar();
    const refresh = this.#refreshCommentary();
    await this.#playCommentary();
    await refresh;
  }

  async #playCommentary() {
    if (!this.commentaryEnabled) return null;
    const counts = aggregatePanelTagCounts(
      this.store.getState().panels,
      this.#currentMediaTagLookup(),
    );
    this.commentaryScores = scoreCommentary(this.commentaryEntries, counts);
    const entry = selectCommentary(this.commentaryEntries, counts, {
      previousPath: this.commentaryPath,
    });
    if (!entry) throw new Error("No commentary files are available.");

    const audio = this.#ensureCommentaryAudio();
    const generation = ++this.commentaryPlaybackGeneration;
    this.commentaryPath = entry.path;
    this.commentaryCaptionTimeline = parseCaptionTimeline(entry.caption);
    this.captionView.setText(captionAtTime(this.commentaryCaptionTimeline, 0));
    this.commentaryPlaying = false;
    this.#syncCommentaryToolbar();
    audio.src = this.api.commentaryFileUrl(entry.path);
    this.commentaryAudioVolume?.prepare(entry.volume);
    this.commentaryAudioVolume?.apply(entry.volume);
    audio.load?.();
    try {
      await audio.play();
    } catch (error) {
      if (this.commentaryEnabled && generation === this.commentaryPlaybackGeneration) {
        throw error;
      }
      return null;
    }
    if (!this.commentaryEnabled || generation !== this.commentaryPlaybackGeneration) {
      audio.pause?.();
      return null;
    }
    this.commentaryPlaying = true;
    this.#syncCommentaryToolbar();
    return entry;
  }

  #toolbarAction(action) {
    if (action === "add-panel") {
      const count = this.store.getState().panels.length;
      this.store.add({
        transform: {
          position: {
            x: ((count % 3) - 1) * 0.42,
            y: 1.25 + Math.floor(count / 3) * 0.16,
            z: -1.35 - Math.floor(count / 3) * 0.12,
          },
        },
      });
    } else if (action === "remove-panel") {
      const { focusedId } = this.store.getState();
      if (focusedId) this.store.remove(focusedId);
    } else if (action === "toggle-commentary") {
      if (!this.commentaryAvailable && !this.commentaryEntries.length) return;
      this.#toggleCommentary().catch((error) => this.#failCommentary(error));
    } else if (action === "toggle-environment-menu") {
      this.toolbar.toggleEnvironmentMenu();
    } else if (action.startsWith("set-environment:")) {
      const mode = action.slice("set-environment:".length);
      this.setEnvironmentMode(mode);
      this.toolbar.setEnvironmentMenuOpen(false);
    }
  }

  #panelAction(panelId, action) {
    const panel = this.#panel(panelId);
    if (!panel) return;
    this.store.focus(panelId);
    if (action === "browse") {
      this.#openBrowser(panel);
    } else if (action === "toggle-media-tags") {
      this.#toggleMediaTags(panel).catch((error) => {
        this.onError?.(new Error(`Could not open media tags: ${error.message}`));
      });
    } else if (action === "toggle-lock") {
      this.store.setLocked(panelId, !panel.locked);
    } else if (action === "toggle-minimize") {
      if (panel.minimized) this.store.restore(panelId);
      else this.store.minimize(panelId);
    } else if (action === "toggle-zoom") {
      this.store.setZoomMode(panelId, !panel.zoomMode);
    } else if (action === "cycle-display-mode") {
      const nextMode = nextDisplayMode(panel.displayMode);
      this.store.setDisplayMode(panelId, nextMode);
      this.panelViews.get(panelId)?.showDisplayModeIndicator(nextMode);
    } else if (action === "cycle-aspect-ratio") {
      const nextMode = nextAspectRatioMode(panel.aspectRatioMode);
      this.store.setAspectRatioMode(panelId, nextMode);
      this.#applyAspectRatio(panelId, nextMode);
      this.panelViews.get(panelId)?.showAspectRatioIndicator(nextMode);
    } else if (action === "toggle-slideshow") {
      this.#toggleSlideshow(panel);
    } else if (action === "toggle-mask") {
      this.#toggleMask(panel);
    } else if (action === "edit-erase-mask") {
      this.#beginMaskEditor(panel);
    } else if (action.startsWith("mask-")) {
      this.#maskEditorAction(panel, action);
    } else if (action === "previous" || action === "next") {
      this.#navigate(panel, action);
    }
  }

  #isCurrentMedia(panelId, path, generation) {
    return this.mediaGenerations.get(panelId) === generation
      && this.#panel(panelId)?.media.selectedId === path
      && this.panelViews.has(panelId);
  }

  async #loadMaskForPanel(panelId, item, generation) {
    const maskVersion = this.maskVersions.get(item.path) ?? 0;
    const info = await this.api.maskInfo(item.path);
    if (!this.#isCurrentMedia(panelId, item.path, generation)
      || (this.maskVersions.get(item.path) ?? 0) !== maskVersion) return;
    const view = this.panelViews.get(panelId);
    if (!info?.exists) {
      this.maskCache.delete(item.path);
      view.setMask(null);
      view.setMaskAvailable(false);
      return;
    }
    const blob = await this.api.loadMask(item.path);
    if (!this.#isCurrentMedia(panelId, item.path, generation)
      || (this.maskVersions.get(item.path) ?? 0) !== maskVersion) return;
    const dimensions = view.getMediaDimensions();
    if (!dimensions) return;
    const canvas = await maskCanvasFromBlob(blob, dimensions);
    if (!this.#isCurrentMedia(panelId, item.path, generation)
      || (this.maskVersions.get(item.path) ?? 0) !== maskVersion) return;
    const record = { canvas, blur: clampMaskBlur(info.blur) };
    this.#cacheMask(item.path, record);
    const panel = this.#panel(panelId);
    view.setMask(record.canvas, { blur: record.blur, enabled: panel?.maskEnabled !== false });
    view.setMaskAvailable(true);
  }

  #toggleMask(panel) {
    const record = this.maskCache.get(panel.media.selectedId);
    if (!record) return;
    const next = !panel.maskEnabled;
    this.store.setMaskEnabled(panel.id, next);
    this.panelViews.get(panel.id)?.setMask(record.canvas, {
      blur: record.blur,
      enabled: next,
    });
  }

  #beginMaskEditor(panel) {
    const view = this.panelViews.get(panel.id);
    const dimensions = view?.getMediaDimensions();
    if (!view || !dimensions) {
      this.onError?.(new Error("Load an image or video before editing its erase mask."));
      return;
    }
    if (this.maskEditor) this.#cancelMaskEditor();
    if (this.#runtimeFor(panel.id).slideshow.active) {
      this.#toggleSlideshow(panel);
    }
    const saved = this.maskCache.get(panel.media.selectedId) ?? null;
    const working = saved
      ? cloneEraseMaskCanvas(saved.canvas)
      : createEraseMaskCanvas(dimensions.width, dimensions.height);
    this.maskEditor = {
      panelId: panel.id,
      path: panel.media.selectedId,
      canvas: working,
      saved,
      brushSize: 0.05,
      blur: saved?.blur ?? 0,
      previousPoint: null,
      applying: false,
    };
    view.beginMaskEditor(working, this.maskEditor);
  }

  #drawMask(panelId, phase, uv) {
    const editor = this.maskEditor;
    if (!editor || editor.panelId !== panelId || editor.applying) return;
    if (this.#panel(panelId)?.media.selectedId !== editor.path) {
      this.#cancelMaskEditor({ restore: false });
      return;
    }
    if (phase === "start") {
      editor.previousPoint = uv;
      paintEraseStroke(editor.canvas, uv, uv, editor.brushSize);
    } else if (phase === "update") {
      const previous = editor.previousPoint ?? uv;
      paintEraseStroke(editor.canvas, previous, uv, editor.brushSize);
      editor.previousPoint = uv;
    } else if (phase === "end") {
      editor.previousPoint = null;
    }
    this.panelViews.get(panelId)?.updateMaskEditor(editor.canvas, editor);
  }

  #maskEditorAction(panel, action) {
    const editor = this.maskEditor;
    if (!editor || editor.panelId !== panel.id || editor.applying) return;
    if (action === "mask-clear") {
      clearEraseMask(editor.canvas);
    } else if (action === "mask-cancel") {
      this.#cancelMaskEditor();
      return;
    } else if (action === "mask-apply") {
      this.#applyMaskEditor().catch((error) => {
        editor.applying = false;
        this.onError?.(new Error(`Could not save erase mask: ${error.message}`));
      });
      return;
    }
    this.panelViews.get(panel.id)?.updateMaskEditor(editor.canvas, editor);
  }

  #setMaskEditorSetting(panelId, setting, value) {
    const editor = this.maskEditor;
    if (!editor || editor.panelId !== panelId || editor.applying) return;
    if (setting === "brushSize") {
      editor.brushSize = clampBrushSize(value);
    } else if (setting === "blur") {
      editor.blur = clampMaskBlur(value);
    } else {
      throw new TypeError(`Unknown mask editor setting: ${setting}`);
    }
    this.panelViews.get(panelId)?.updateMaskEditor(editor.canvas, editor);
  }

  #cancelMaskEditor({ restore = true } = {}) {
    const editor = this.maskEditor;
    if (!editor) return;
    const view = this.panelViews.get(editor.panelId);
    view?.endMaskEditor();
    const panel = this.#panel(editor.panelId);
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
    this.maskEditor = null;
  }

  async #applyMaskEditor() {
    const editor = this.maskEditor;
    if (!editor || editor.applying) return;
    if (this.#panel(editor.panelId)?.media.selectedId !== editor.path) {
      this.#cancelMaskEditor({ restore: false });
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
      this.#cacheMask(editor.path, {
        canvas: binaryCanvas,
        blur: clampMaskBlur(response?.blur ?? editor.blur),
      });
    } else {
      await this.api.deleteMask(editor.path);
      this.maskCache.delete(editor.path);
    }
    this.maskVersions.set(editor.path, (this.maskVersions.get(editor.path) ?? 0) + 1);
    const path = editor.path;
    this.panelViews.get(editor.panelId)?.endMaskEditor();
    this.maskEditor = null;
    this.#applyCachedMaskToMatchingPanels(path);
  }

  #applyCachedMaskToMatchingPanels(path) {
    const record = this.maskCache.get(path);
    for (const panel of this.store.getState().panels) {
      if (panel.media.selectedId !== path) continue;
      const view = this.panelViews.get(panel.id);
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

  #cacheMask(path, record) {
    this.maskCache.delete(path);
    this.maskCache.set(path, record);
    if (this.maskCache.size <= MAX_CACHED_MASKS) return;
    const retained = new Set(
      this.store.getState().panels.map((panel) => panel.media.selectedId).filter(Boolean),
    );
    if (this.maskEditor?.path) retained.add(this.maskEditor.path);
    for (const cachedPath of this.maskCache.keys()) {
      if (this.maskCache.size <= MAX_CACHED_MASKS) break;
      if (!retained.has(cachedPath)) this.maskCache.delete(cachedPath);
    }
  }

  async #openBrowser(panel) {
    this.browser?.dispose();
    if (this.browser) this.scene.remove(this.browser);
    const settings = this.getSettings();
    const browser = new MediaBrowserView({
      api: this.api,
      selectedDirectories: settings.mediaDirectories,
      sortEntries: (entries, mode) => this.#sort(entries, mode),
      onSelect: (entry, context) => this.#selectMedia(panel.id, entry, context),
      onError: (error) => this.onError?.(error),
      tagDefinitions: this.tagDefinitions,
      tagFilter: panel.tagFilter,
      onTagFilterChange: (tagIds) => this.#setPanelTagFilter(panel.id, tagIds),
      onOpenTagFilter: () => this.#refreshTagDefinitions(),
    });
    browser.panelId = panel.id;
    this.browser = browser;
    browser.visible = false;
    this.scene.add(browser);
    browser.viewMode = panel.media.view === "grid" ? "large" : panel.media.view;
    browser.sortMode = panel.media.sort;
    const startPath =
      panel.media.directory ?? settings.mediaDirectories.at(0) ?? "";
    try {
      const definitions = await this.#refreshTagDefinitions();
      if (this.browser !== browser) return;
      browser.setTagDefinitions(definitions);
      browser.setTagFilter(this.#panel(panel.id)?.tagFilter ?? []);
      await browser.open(startPath);
      if (this.browser !== browser) return;
      this.controls.update();
      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);
      browser.position.copy(this.camera.position).add(forward.multiplyScalar(1.15));
      browser.quaternion.copy(this.camera.quaternion);
      browser.visible = true;
    } catch (error) {
      this.onError?.(new Error(`Could not open media browser: ${error.message}`));
    }
  }

  #selectMedia(panelId, entry, context) {
    const media = normalizeMediaEntry(entry);
    const runtime = this.#runtimeFor(panelId);
    runtime.playlist = context.entries.map(normalizeMediaEntry);
    this.#rememberMediaTags(runtime.playlist);
    this.#rememberMediaTags(media);
    this.store.setDirectory(panelId, context.directory);
    this.store.setSort(panelId, context.sortMode);
    this.store.setView(
      panelId,
      context.viewMode === "large" ? "grid" : context.viewMode,
    );
    this.store.setMedia(panelId, mediaId(media));
    this.browser.visible = false;
  }

  #navigate(panel, direction) {
    const runtime = this.#runtimeFor(panel.id);
    const item =
      direction === "next"
        ? nextMedia(runtime.playlist, panel.media.selectedId)
        : previousMedia(runtime.playlist, panel.media.selectedId);
    if (item) this.store.setMedia(panel.id, mediaId(item));
  }

  #toggleSlideshow(panel) {
    const runtime = this.#runtimeFor(panel.id);
    const type = runtime.slideshow.active ? "stop" : "start";
    runtime.slideshow = slideshowTransition(
      runtime.slideshow,
      { type, now: performance.now() },
    ).state;
    if (runtime.slideshow.active && panel.media.selectedId) {
      const current = runtime.playlist.find(
        (item) => mediaId(item) === panel.media.selectedId,
      );
      if (current) this.#showMedia(panel.id, current);
    }
    this.#syncState(this.store.getState());
  }

  #videoEnded(panelId) {
    const panel = this.#panel(panelId);
    if (!panel) return;
    this.#advanceSlideshow(panel, { type: "media-ended", now: performance.now() });
  }

  #advanceSlideshow(panel, event) {
    const runtime = this.#runtimeFor(panel.id);
    const current = runtime.playlist.find(
      (item) => mediaId(item) === panel.media.selectedId,
    );
    const transition = slideshowTransition(runtime.slideshow, event, {
      playlist: runtime.playlist,
      currentMedia: current,
    });
    runtime.slideshow = transition.state;
    if (transition.action?.media) {
      this.store.setMedia(panel.id, mediaId(transition.action.media));
    }
  }

  #focus(target) {
    if (typeof target === "string") this.store.focus(target);
  }

  #panel(panelId) {
    return this.store.getState().panels.find((panel) => panel.id === panelId) ?? null;
  }

  #applyAspectRatio(panelId, mode) {
    const panel = this.#panel(panelId);
    if (!panel) return false;
    const source = this.panelViews.get(panelId)?.getNativeImageDimensions() ?? {};
    const currentDimensions = panel.minimized
      ? panel.restoreDimensions
      : panel.dimensions;
    const nextDimensions = dimensionsForAspectRatio({
      width: currentDimensions?.width,
      mode,
      sourceWidth: source.width,
      sourceHeight: source.height,
      ...PANEL_DIMENSION_LIMITS,
    });
    if (!nextDimensions) return false;
    this.store.setDimensions(panelId, nextDimensions);
    return true;
  }

  /**
   * Applies an interaction gesture. Kept public so non-XR integrations can use
   * the same absolute gesture contract as the controller.
   */
  applyGesture(target, gesture) {
    this.#gesture(target, gesture);
  }

  #gesture(target, gesture) {
    if (typeof target?.onGesture === "function") {
      target.onGesture(gesture);
      return;
    }
    const panelId = target;
    const panel = this.#panel(panelId);
    if (!panel) return;
    if (gesture.absolutePose
      && (panel.minimized || (!panel.locked && !panel.zoomMode))) {
      this.store.setTransform(panelId, gesture.absolutePose);
      if (!panel.minimized && gesture.hands === 2 && gesture.absoluteDimensions
        && Number.isFinite(gesture.absoluteDimensions.width)
        && Number.isFinite(gesture.absoluteDimensions.height)) {
        this.store.setDimensions(panelId, gesture.absoluteDimensions);
      }
      return;
    }
    const next = applyPanelGesture(panel, gesture);
    if (gesture.hands === 1) {
      if (panel.locked || panel.zoomMode) {
        this.store.setContentPan(panelId, next.content.pan);
      } else {
        this.store.setTransform(panelId, next.transform);
      }
    } else if (gesture.hands === 2) {
      if (panel.locked || panel.zoomMode) {
        this.store.setContentZoom(panelId, next.content.zoom);
      } else if (!panel.minimized) {
        this.store.setDimensions(panelId, next.dimensions);
      }
    }
  }

  #render(time) {
    this.controls.update();
    this.interactions.update();
    const state = this.store.getState();
    for (const panel of state.panels) {
      this.#advanceSlideshow(panel, { type: "tick", now: time });
    }
    const captionSettings = this.getSettings();
    const viewCamera = this.renderer.xr.isPresenting
      ? this.renderer.xr.getCamera(this.camera)
      : this.camera;
    this.captionView.setStyle({
      size: captionSettings.captionSize,
      transparency: captionSettings.captionTransparency,
    });
    this.captionView.setText(
      this.commentaryEnabled && this.commentaryAudio
        ? captionAtTime(this.commentaryCaptionTimeline, this.commentaryAudio.currentTime)
        : "",
    );
    this.captionView.updatePose(viewCamera, captionSettings.captionDistance);
    this.environmentEffects.render(this.renderer, this.scene, this.camera, time);
  }

  #resize() {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  #scheduleSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.#persistNow(), 120);
  }

  #persistNow() {
    window.clearTimeout(this.saveTimer);
    saveLayout(
      this.storage,
      this.store.getState(),
      this.runtime,
      this.libraryId,
      this.environmentMode,
    );
  }

  #setPanelTagFilter(panelId, tagIds) {
    this.store.setTagFilter(panelId, tagIds);
    const panel = this.#panel(panelId);
    if (panel) {
      this.#reloadPlaylistAfterTagChange(panel).catch((error) => this.onError?.(
        new Error(`Could not refresh filtered playlist: ${error.message}`),
      ));
    }
  }

  async #refreshTagDefinitions() {
    const definitions = tagDefinitions(await this.api.tags());
    this.tagDefinitions = definitions;
    const validIds = definitions.map((definition) => definition.id);
    this.store.reconcileTagFilters(validIds);
    for (const view of this.panelViews.values()) view.setTagDefinitions(definitions);
    if (this.browser) {
      this.browser.setTagDefinitions(definitions);
      const panel = this.#panel(this.browser.panelId);
      if (panel) this.browser.setTagFilter(panel.tagFilter);
    }
    for (const panel of this.store.getState().panels) {
      this.#reloadPlaylistAfterTagChange(panel).catch((error) => this.onError?.(
        new Error(`Could not refresh filtered playlist: ${error.message}`),
      ));
    }
    return definitions;
  }

  async #toggleMediaTags(panel) {
    const path = panel.media.selectedId;
    if (!path) return;
    await this.#refreshTagDefinitions();
    const assignments = tagIdsFromResponse(await this.api.mediaTags(path));
    const current = this.#panel(panel.id);
    if (!current || current.media.selectedId !== path) return;
    this.panelViews.get(panel.id)?.toggleMediaTags(this.tagDefinitions, assignments);
  }

  async #saveMediaTags(panelId, tagIds) {
    const panel = this.#panel(panelId);
    const path = panel?.media.selectedId;
    if (!path) throw new Error("Select media before changing its tags.");
    const nextTagIds = normalizeTagIds(tagIds);
    await this.api.saveMediaTags(path, nextTagIds);
    this.#applyMediaTagAssignment(path, nextTagIds);
  }

  #applyMediaTagAssignment(path, tagIds) {
    this.mediaTagLookup.set(path, [...tagIds]);
    for (const [panelId, runtime] of this.runtime) {
      for (const item of runtime.playlist) {
        if (item.path === path) item.tag_ids = [...tagIds];
      }
      const panel = this.#panel(panelId);
      if (panel?.media.selectedId === path) {
        this.panelViews.get(panelId)?.setMediaTagSelection(tagIds);
      }
      // The selected media may stay displayed after it no longer matches; navigation
      // and slideshow use this filtered playlist immediately.
      if (panel) {
        runtime.playlist = runtime.playlist.filter((item) => matchesTagFilter(item, panel.tagFilter));
        this.#reloadPlaylistAfterTagChange(panel).catch((error) => this.onError?.(
          new Error(`Could not refresh tagged playlist: ${error.message}`),
        ));
      }
    }
    this.browser?.updateEntryTags(path, tagIds);
  }

  async #reloadPlaylistAfterTagChange(panel) {
    if (!panel.media.directory) return;
    const generation = (this.playlistGenerations.get(panel.id) ?? 0) + 1;
    this.playlistGenerations.set(panel.id, generation);
    const directory = panel.media.directory;
    const filter = normalizeTagIds(panel.tagFilter);
    const payload = await this.api.directory(
      directory,
      this.getSettings().mediaDirectories,
    );
    const current = this.#panel(panel.id);
    if (
      this.playlistGenerations.get(panel.id) !== generation ||
      current?.media.directory !== directory ||
      current.tagFilter.length !== filter.length ||
      !current.tagFilter.every((tagId, index) => tagId === filter[index])
    ) {
      return;
    }
    const entries = (payload.entries ?? payload.items ?? payload ?? [])
      .filter((entry) => entry.kind !== "directory")
      .map(normalizeMediaEntry)
      .filter((entry) => matchesTagFilter(entry, filter));
    this.#runtimeFor(panel.id).playlist = this.#sort(entries, current.media.sort);
    this.#rememberMediaTags(entries);
  }
}
