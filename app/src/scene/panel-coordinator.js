import * as THREE from "three";

import {
  PanelStore,
  applyPanelGesture,
  createPersistentRandomSeed,
  createSlideshowState,
  interactionMode,
  matchesTagFilter,
  mediaId,
  nextMedia,
  normalizeMediaEntry,
  normalizeTagDefinitions,
  normalizeTagIds,
  panelColor,
  playbackPolicy,
  previousMedia,
  slideshowTransition,
  sortMedia,
} from "../core/index.js";
import { loadLayout, saveLayout } from "./layout-storage.js";
import { MediaBrowserView } from "./media-browser-view.js";
import { PanelView } from "./panel-view.js";

const DEFAULT_PANEL_POSITION = { x: 0, y: 1.35, z: -1.45 };

function layoutRuntime(value = {}) {
  return {
    playlist: Array.isArray(value.playlist) ? value.playlist.map(normalizeMediaEntry) : [],
    slideshow: createSlideshowState(value.slideshow ?? {}),
  };
}

function normalizedTagDefinitions(payload) {
  const values = Array.isArray(payload) ? payload : payload?.tags ?? payload?.definitions ?? [];
  return normalizeTagDefinitions(values);
}

// Owns panel state, views, media runtime, browsing, tags, gestures, and layout persistence.
export class PanelCoordinator {
  constructor({
    api,
    settings,
    storage,
    libraryId,
    scene,
    camera,
    maskWorkflow,
    getEnvironmentMode,
    setEnvironmentMode,
    isZenMode,
    updateControls,
    onPanelsChanged,
    onCompositionChanged,
    onError,
  }) {
    this.api = api;
    this.getSettings = settings;
    this.storage = storage;
    this.libraryId = libraryId;
    this.scene = scene;
    this.camera = camera;
    this.maskWorkflow = maskWorkflow;
    this.getEnvironmentMode = getEnvironmentMode;
    this.isZenMode = isZenMode;
    this.updateControls = updateControls;
    this.onPanelsChanged = onPanelsChanged;
    this.onCompositionChanged = onCompositionChanged;
    this.onError = onError;
    this.panelViews = new Map();
    this.panelState = { panels: [], focusedId: null };
    this.panelTagFilterSignatures = new Map();
    this.runtime = new Map();
    this.tagDefinitions = [];
    this.playlistGenerations = new Map();
    this.loadedMedia = new Map();
    this.mediaGenerations = new Map();
    this.mediaTagLookup = new Map();
    this.pendingTagSaves = new Set();
    this.browser = null;
    this.saveTimer = null;

    let saved = {
      panels: [],
      focusedId: null,
      runtime: {},
      environmentMode: getEnvironmentMode(),
      libraryId,
    };
    try {
      saved = loadLayout(storage, libraryId);
    } catch (error) {
      onError?.(error);
      storage.removeItem("souvenir.layout.v1");
    }
    this.store = new PanelStore({
      panels: saved.panels,
      focusedId: saved.focusedId,
    });
    for (const [panelId, value] of Object.entries(saved.runtime)) {
      this.runtime.set(panelId, layoutRuntime(value));
    }
    setEnvironmentMode(saved.environmentMode, { persist: false });
    if (this.store.getState().panels.length === 0) {
      this.store.add({ transform: { position: DEFAULT_PANEL_POSITION } });
    }
    this.panelState = this.store.getState();
    this.unsubscribe = this.store.subscribe((state, change) => this.reconcile(state, change));
    this.reconcile(this.panelState, {
      type: "structure",
      panelIds: this.panelState.panels.map((panel) => panel.id),
      focusChanged: true,
    });
  }

  getPanel(panelId) {
    return this.panelState.panels.find((panel) => panel.id === panelId) ?? null;
  }

  runtimeFor(panelId) {
    if (!this.runtime.has(panelId)) this.runtime.set(panelId, layoutRuntime());
    return this.runtime.get(panelId);
  }

  getMediaTagLookup() {
    const lookup = new Map(this.mediaTagLookup);
    for (const runtime of this.runtime.values()) this.rememberMediaTags(runtime.playlist);
    for (const panel of this.panelState.panels) {
      const selected = this.runtimeFor(panel.id).playlist.find(
        (item) => mediaId(item) === panel.media.selectedId,
      );
      if (selected) this.rememberMediaTags(selected);
    }
    for (const [path, tagIds] of this.mediaTagLookup) lookup.set(path, tagIds);
    return lookup;
  }

  /**
   * Reconciles only structurally or explicitly changed panels, preserving
   * expensive Three.js resources for unrelated store updates.
   */
  reconcile(state, change = null) {
    this.panelState = state;
    const structural = !change || change.type === "structure" || change.type === "reset";
    const changedPanelIds = structural
      ? new Set(state.panels.map((panel) => panel.id))
      : new Set(change.panelIds ?? []);
    const panelIds = new Set(state.panels.map((panel) => panel.id));
    const panelEntries = state.panels.map((panel, index) => ({
      id: panel.id,
      number: index + 1,
      color: panelColor(index),
    }));
    if (structural) {
      for (const [panelId, view] of this.panelViews) {
        if (!panelIds.has(panelId)) {
          view.dispose();
          this.scene.remove(view);
          this.panelViews.delete(panelId);
          this.runtime.delete(panelId);
          this.loadedMedia.delete(panelId);
          this.mediaGenerations.delete(panelId);
          this.maskWorkflow.panelRemoved(panelId);
          this.playlistGenerations.delete(panelId);
          this.panelTagFilterSignatures.delete(panelId);
          this.pendingTagSaves.delete(panelId);
        }
      }
    }

    for (const [index, panel] of state.panels.entries()) {
      if (!changedPanelIds.has(panel.id)) continue;
      const runtime = this.runtimeFor(panel.id);
      const tagFilterSignature = panel.tagFilter.join("\u0000");
      const tagFilterChanged = this.panelTagFilterSignatures.get(panel.id) !== tagFilterSignature;
      if (tagFilterChanged) {
        this.panelTagFilterSignatures.set(panel.id, tagFilterSignature);
        runtime.playlist = runtime.playlist.filter((item) => matchesTagFilter(item, panel.tagFilter));
      }
      let view = this.panelViews.get(panel.id);
      if (!view) {
        view = new PanelView(panel, {
          onAction: (panelId, action) => this.handleAction(panelId, action),
          onVideoEnded: (panelId) => this.videoEnded(panelId),
          onMaskDraw: (panelId, phase, uv) => this.maskWorkflow.draw(panelId, phase, uv),
          onMaskSetting: (panelId, setting, value) => {
            this.maskWorkflow.setEditorSetting(panelId, setting, value);
          },
          onAdmSetting: (panelId, setting, value) => {
            this.maskWorkflow.setAdmSetting(panelId, setting, value);
          },
          onError: (error) => this.onError?.(error),
        });
        this.panelViews.set(panel.id, view);
        this.scene.add(view);
      }
      view.applyState({
        ...panel,
        number: index + 1,
        color: panelColor(index),
        focused: state.focusedId === panel.id,
        slideshow: { playing: runtime.slideshow.active },
      });
      view.setTagDefinitions(this.tagDefinitions);
      const selected = runtime.playlist.find((item) => mediaId(item) === panel.media.selectedId);
      if (selected) this.rememberMediaTags(selected);
      view.setMediaTagSelection(selected?.tag_ids ?? []);
      if (tagFilterChanged && this.browser?.panelId === panel.id) {
        this.browser.setTagFilter(panel.tagFilter);
      }
      if (
        panel.media.selectedId
        && !this.isMediaLoaded(panel.id, panel.media.selectedId)
      ) {
        if (selected) {
          this.showMedia(panel.id, selected);
        } else {
          this.restorePlaylist(panel).catch((error) => this.onError?.(error));
        }
      }
    }
    if (structural || change?.focusChanged) {
      this.onPanelsChanged?.(panelEntries, state.focusedId);
    }
    this.scheduleSave();
    this.onCompositionChanged?.();
  }

  async restorePlaylist(panel) {
    if (!panel.media.directory) return;
    const payload = await this.api.directory(
      panel.media.directory,
      this.getSettings().mediaDirectories,
    );
    const entries = (payload.entries ?? payload.items ?? payload ?? [])
      .filter((entry) => entry.kind !== "directory")
      .map(normalizeMediaEntry)
      .filter((entry) => matchesTagFilter(entry, panel.tagFilter));
    const runtime = this.runtimeFor(panel.id);
    runtime.playlist = this.sort(entries, panel.media.sort);
    this.rememberMediaTags(entries);
    this.maskWorkflow.rememberAdm(entries);
    const selected = runtime.playlist.find((item) => mediaId(item) === panel.media.selectedId);
    if (selected) {
      this.panelViews.get(panel.id)?.setMediaTagSelection(selected.tag_ids);
      await this.showMedia(panel.id, selected);
    } else {
      this.store.setMedia(panel.id, null);
      this.onError?.(new Error("A saved media file is no longer available and was cleared."));
    }
  }

  sort(entries, mode) {
    const seed = createPersistentRandomSeed({ storage: this.storage });
    return sortMedia(entries.map(normalizeMediaEntry), { mode, seed });
  }

  async showMedia(panelId, item) {
    const view = this.panelViews.get(panelId);
    if (!view) return;
    const generation = this.beginMediaRequest(panelId, item);
    this.rememberMediaTags(item);
    const runtime = this.runtimeFor(panelId);
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
    if (!this.isCurrentMediaRequest(panelId, item.path, generation)) return;
    const panel = this.getPanel(panelId);
    if (!result && panel?.media.selectedId === mediaId(item)) {
      this.loadedMedia.delete(panelId);
    }
    if (result) {
      const current = this.getPanel(panelId);
      const width = result.naturalWidth ?? result.width;
      const height = result.naturalHeight ?? result.height;
      if (current && !current.mediaPoses[mediaId(item)]
        && Number.isFinite(width) && width > 0
        && Number.isFinite(height) && height > 0) {
        this.store.setDimensions(panelId, {
          width: current.dimensions.width,
          height: current.dimensions.width * height / width,
        });
      }
      this.maskWorkflow.loadPanelEffects(panelId, item, generation);
    }
    this.scheduleSave();
  }

  rememberMediaTags(media) {
    for (const item of Array.isArray(media) ? media : [media]) {
      const path = String(item?.path ?? item?.id ?? "").trim();
      if (path) this.mediaTagLookup.set(path, normalizeTagIds(item?.tag_ids));
    }
  }

  isMediaLoaded(panelId, path) {
    return this.loadedMedia.get(panelId) === path;
  }

  beginMediaRequest(panelId, item) {
    const generation = (this.mediaGenerations.get(panelId) ?? 0) + 1;
    this.mediaGenerations.set(panelId, generation);
    this.loadedMedia.set(panelId, mediaId(item));
    this.maskWorkflow.prepareMedia(panelId, item);
    return generation;
  }

  getMediaGeneration(panelId) {
    return this.mediaGenerations.get(panelId) ?? 0;
  }

  isCurrentMediaRequest(panelId, path, generation) {
    return this.mediaGenerations.get(panelId) === generation
      && this.getPanel(panelId)?.media.selectedId === path
      && this.panelViews.has(panelId);
  }

  handleAction(panelId, action) {
    const panel = this.getPanel(panelId);
    if (!panel) return;
    this.store.focus(panelId);
    if (action === "browse") {
      this.openBrowser(panel);
    } else if (action === "toggle-options") {
      this.panelViews.get(panel.id)?.toggleOptions();
    } else if (action.startsWith("toggle-media-tag:")) {
      if (this.pendingTagSaves.has(panelId)) return;
      const tagId = action.slice("toggle-media-tag:".length);
      const currentIds = this.mediaTagLookup.get(panel.media.selectedId) ?? [];
      const nextIds = panel.media.selectedId
        ? currentIds.includes(tagId)
          ? currentIds.filter((id) => id !== tagId)
          : [...currentIds, tagId]
        : [];
      this.pendingTagSaves.add(panelId);
      this.saveMediaTags(panelId, nextIds)
        .catch((error) => {
          this.onError?.(new Error(`Could not save media tags: ${error.message}`));
        })
        .finally(() => this.pendingTagSaves.delete(panelId));
    } else if (action.startsWith("set-save-mode:")) {
      this.store.setSaveMode(panelId, action.slice("set-save-mode:".length));
    } else if (action === "toggle-lock") {
      this.store.setLocked(panelId, !panel.locked);
    } else if (action === "toggle-minimize") {
      if (panel.minimized) this.store.restore(panelId);
      else this.store.minimize(panelId);
    } else if (action === "toggle-slideshow") {
      this.toggleSlideshow(panel);
    } else if (action === "toggle-mask") {
      this.maskWorkflow.toggleMask(panel);
    } else if (action === "toggle-3d-mode") {
      this.maskWorkflow.toggleAdm(panel).catch((error) => {
        this.onError?.(new Error(`Could not toggle 3D mode: ${error.message}`));
      });
    } else if (action === "edit-erase-mask") {
      this.maskWorkflow.beginEditor(panel);
    } else if (action === "adm-generate-confirm") {
      this.maskWorkflow.confirmAdmGeneration(panel).catch((error) => {
        this.onError?.(new Error(`Could not start ADM generation: ${error.message}`));
      });
    } else if (action === "adm-generate-cancel") {
      this.maskWorkflow.cancelAdmGeneration(panel);
    } else if (action.startsWith("mask-")) {
      this.maskWorkflow.editorAction(panel, action);
    } else if (action === "previous" || action === "next") {
      this.navigate(panel, action);
    }
  }

  isTagSavePending(panelId) {
    return this.pendingTagSaves.has(panelId);
  }

  async openBrowser(panel) {
    this.browser?.dispose();
    if (this.browser) this.scene.remove(this.browser);
    const settings = this.getSettings();
    const browser = new MediaBrowserView({
      api: this.api,
      selectedDirectories: settings.mediaDirectories,
      sortEntries: (entries, mode) => this.sort(entries, mode),
      onSelect: (entry, context) => this.selectMedia(panel.id, entry, context),
      onError: (error) => this.onError?.(error),
      tagDefinitions: this.tagDefinitions,
      tagFilter: panel.tagFilter,
      onTagFilterChange: (tagIds) => this.setPanelTagFilter(panel.id, tagIds),
      onOpenTagFilter: () => this.refreshTagDefinitions(),
    });
    browser.panelId = panel.id;
    this.browser = browser;
    browser.visible = false;
    this.scene.add(browser);
    browser.viewMode = panel.media.view === "grid" ? "large" : panel.media.view;
    browser.sortMode = panel.media.sort;
    const startPath = panel.media.directory ?? settings.mediaDirectories.at(0) ?? "";
    try {
      const definitions = await this.refreshTagDefinitions();
      if (this.browser !== browser) return;
      browser.setTagDefinitions(definitions);
      browser.setTagFilter(this.getPanel(panel.id)?.tagFilter ?? []);
      await browser.open(startPath);
      if (this.browser !== browser) return;
      this.updateControls?.();
      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);
      browser.position.copy(this.camera.position).add(forward.multiplyScalar(1.15));
      browser.quaternion.copy(this.camera.quaternion);
      browser.visible = true;
    } catch (error) {
      this.onError?.(new Error(`Could not open media browser: ${error.message}`));
    }
  }

  selectMedia(panelId, entry, context) {
    const media = normalizeMediaEntry(entry);
    const runtime = this.runtimeFor(panelId);
    runtime.playlist = context.entries.map(normalizeMediaEntry);
    this.rememberMediaTags(runtime.playlist);
    this.maskWorkflow.rememberAdm(runtime.playlist);
    this.rememberMediaTags(media);
    this.maskWorkflow.rememberAdm(media);
    this.store.setMediaContext(panelId, {
      directory: context.directory,
      sort: context.sortMode,
      view: context.viewMode === "large" ? "grid" : context.viewMode,
      selectedId: mediaId(media),
    });
    this.browser.visible = false;
  }

  navigate(panel, direction) {
    const runtime = this.runtimeFor(panel.id);
    const item = direction === "next"
      ? nextMedia(runtime.playlist, panel.media.selectedId)
      : previousMedia(runtime.playlist, panel.media.selectedId);
    if (item) this.store.setMedia(panel.id, mediaId(item));
  }

  toggleSlideshow(panel) {
    const runtime = this.runtimeFor(panel.id);
    const type = runtime.slideshow.active ? "stop" : "start";
    runtime.slideshow = slideshowTransition(
      runtime.slideshow,
      { type, now: performance.now() },
    ).state;
    if (runtime.slideshow.active && panel.media.selectedId) {
      const current = runtime.playlist.find((item) => mediaId(item) === panel.media.selectedId);
      if (current) this.showMedia(panel.id, current);
    }
    this.reconcile(this.panelState, { type: "panel", panelIds: [panel.id] });
  }

  videoEnded(panelId) {
    const panel = this.getPanel(panelId);
    if (panel) this.advanceSlideshow(panel, { type: "media-ended", now: performance.now() });
  }

  advanceSlideshow(panel, event) {
    const runtime = this.runtimeFor(panel.id);
    const current = runtime.playlist.find((item) => mediaId(item) === panel.media.selectedId);
    const transition = slideshowTransition(runtime.slideshow, event, {
      playlist: runtime.playlist,
      currentMedia: current,
    });
    runtime.slideshow = transition.state;
    if (transition.action?.media) {
      this.store.setMedia(panel.id, mediaId(transition.action.media));
    }
  }

  tick(time) {
    for (const panel of this.panelState.panels) {
      this.advanceSlideshow(panel, { type: "tick", now: time });
      this.panelViews.get(panel.id)?.tick(time);
    }
  }

  focus(target) {
    if (typeof target === "string") this.store.focus(target);
  }

  applyGesture(target, gesture) {
    if (typeof target?.onGesture === "function") {
      target.onGesture(gesture);
      return;
    }
    const panel = this.getPanel(target);
    if (!panel) return;
    const zenMode = this.isZenMode();
    const mode = interactionMode(panel, gesture?.hands ?? 0, { zen: zenMode });
    if (zenMode && gesture?.hands === 2) return;
    if (gesture.absolutePose && (panel.minimized || !panel.locked) && !zenMode) {
      const nextDimensions = !panel.minimized && gesture.hands === 2 && gesture.absoluteDimensions
        && Number.isFinite(gesture.absoluteDimensions.width)
        && Number.isFinite(gesture.absoluteDimensions.height)
        ? gesture.absoluteDimensions
        : undefined;
      this.store.setPose(target, {
        transform: gesture.absolutePose,
        dimensions: nextDimensions,
      });
      return;
    }
    const next = applyPanelGesture(panel, gesture, {}, { zen: zenMode });
    if (mode === "panel-transform" && gesture.hands === 1) {
      this.store.setTransform(target, next.transform);
    } else if (mode === "panel-transform" && gesture.hands === 2 && !panel.minimized) {
      this.store.setPose(target, {
        transform: next.transform,
        dimensions: next.dimensions,
      });
    } else if (mode === "panel-rescale" && gesture.hands === 2 && !panel.minimized) {
      this.store.setDimensions(target, next.dimensions);
    }
  }

  applyScenePanelSnapshot(snapshot) {
    const panel = this.getPanel(snapshot.id);
    if (!panel) {
      this.store.add({
        id: snapshot.id,
        media: { ...snapshot.media },
        transform: { ...snapshot.transform },
        dimensions: { ...snapshot.dimensions },
      });
      return;
    }
    this.store.setDirectory(snapshot.id, snapshot.media.directory);
    this.store.setSort(snapshot.id, snapshot.media.sort);
    this.store.setView(snapshot.id, snapshot.media.view);
    this.store.setMedia(snapshot.id, snapshot.media.selectedId);
    this.store.setTransform(snapshot.id, snapshot.transform);
    this.store.setDimensions(snapshot.id, snapshot.dimensions);
  }

  setZenMode(enabled) {
    for (const view of this.panelViews.values()) view.setZenMode(enabled);
  }

  setPanelTagFilter(panelId, tagIds) {
    this.store.setTagFilter(panelId, tagIds);
    const panel = this.getPanel(panelId);
    if (panel) {
      this.reloadPlaylistAfterTagChange(panel).catch((error) => {
        this.onError?.(new Error(`Could not refresh filtered playlist: ${error.message}`));
      });
    }
  }

  async refreshTagDefinitions() {
    const definitions = normalizedTagDefinitions(await this.api.tags());
    this.tagDefinitions = definitions;
    this.store.reconcileTagFilters(definitions.map((definition) => definition.id));
    for (const view of this.panelViews.values()) view.setTagDefinitions(definitions);
    if (this.browser) {
      this.browser.setTagDefinitions(definitions);
      const panel = this.getPanel(this.browser.panelId);
      if (panel) this.browser.setTagFilter(panel.tagFilter);
    }
    for (const panel of this.panelState.panels) {
      this.reloadPlaylistAfterTagChange(panel).catch((error) => {
        this.onError?.(new Error(`Could not refresh filtered playlist: ${error.message}`));
      });
    }
    return definitions;
  }

  async saveMediaTags(panelId, tagIds) {
    const panel = this.getPanel(panelId);
    const path = panel?.media.selectedId;
    if (!path) throw new Error("Select media before changing its tags.");
    const nextTagIds = normalizeTagIds(tagIds);
    await this.api.saveMediaTags(path, nextTagIds);
    this.applyMediaTagAssignment(path, nextTagIds);
  }

  applyMediaTagAssignment(path, tagIds) {
    this.mediaTagLookup.set(path, [...tagIds]);
    for (const [panelId, runtime] of this.runtime) {
      for (const item of runtime.playlist) {
        if (item.path === path) item.tag_ids = [...tagIds];
      }
      const panel = this.getPanel(panelId);
      if (panel?.media.selectedId === path) {
        this.panelViews.get(panelId)?.setMediaTagSelection(tagIds);
      }
      if (panel) {
        runtime.playlist = runtime.playlist.filter((item) => matchesTagFilter(item, panel.tagFilter));
        this.reloadPlaylistAfterTagChange(panel).catch((error) => {
          this.onError?.(new Error(`Could not refresh tagged playlist: ${error.message}`));
        });
      }
    }
    this.browser?.updateEntryTags(path, tagIds);
  }

  async reloadPlaylistAfterTagChange(panel) {
    if (!panel.media.directory) return;
    const generation = (this.playlistGenerations.get(panel.id) ?? 0) + 1;
    this.playlistGenerations.set(panel.id, generation);
    const directory = panel.media.directory;
    const filter = normalizeTagIds(panel.tagFilter);
    const payload = await this.api.directory(directory, this.getSettings().mediaDirectories);
    const current = this.getPanel(panel.id);
    if (
      this.playlistGenerations.get(panel.id) !== generation
      || current?.media.directory !== directory
      || current.tagFilter.length !== filter.length
      || !current.tagFilter.every((tagId, index) => tagId === filter[index])
    ) {
      return;
    }
    const entries = (payload.entries ?? payload.items ?? payload ?? [])
      .filter((entry) => entry.kind !== "directory")
      .map(normalizeMediaEntry)
      .filter((entry) => matchesTagFilter(entry, filter));
    this.runtimeFor(panel.id).playlist = this.sort(entries, current.media.sort);
    this.rememberMediaTags(entries);
    this.maskWorkflow.rememberAdm(entries);
  }

  scheduleSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.persistNow(), 120);
  }

  persistNow() {
    window.clearTimeout(this.saveTimer);
    saveLayout(
      this.storage,
      this.panelState,
      this.runtime,
      this.libraryId,
      this.getEnvironmentMode(),
    );
  }

  dispose() {
    window.clearTimeout(this.saveTimer);
    this.unsubscribe?.();
    this.browser?.dispose();
    for (const view of this.panelViews.values()) view.dispose();
    this.panelViews.clear();
    this.pendingTagSaves.clear();
  }
}
