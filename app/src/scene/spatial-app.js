import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import {
  DEFAULT_ENVIRONMENT_MODE,
  normalizeEnvironmentMode,
} from "../core/index.js";
import { EnvironmentEffects } from "./environment-effects.js";
import { InteractionController } from "./interaction-controller.js";
import { validateLibraryId } from "./layout-storage.js";
import { SpatialToolbar } from "./spatial-toolbar.js";
import { createPreviewEnvironment } from "./environment.js";
import { disposeObject } from "./canvas-ui.js";
import { CommentaryController } from "./commentary-controller.js";
import { ScenePlaybackController } from "./scene-playback-controller.js";
import { MaskWorkflow } from "./mask-workflow.js";
import { PanelCoordinator } from "./panel-coordinator.js";

export class SpatialApp {
  constructor({
    canvas,
    api,
    settings,
    storage,
    libraryId,
    onExit,
    onError,
    onSceneStateChange,
  }) {
    this.canvas = canvas;
    this.api = api;
    this.getSettings = settings;
    this.storage = storage;
    this.libraryId = validateLibraryId(libraryId);
    this.onExit = onExit;
    this.onError = onError;
    this.running = false;
    this.immersive = false;
    this.zenMode = false;
    this.environmentMode = DEFAULT_ENVIRONMENT_MODE;
    this.environmentBlendMode = "unknown";
    this.onSceneStateChange = onSceneStateChange;
    this.#initializeScene();
    this.scenePlayback.emitState();
  }

  #initializeScene() {
    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.desktopOverlayScene = new THREE.Scene();
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
    this.toolbar.setZenMode(this.zenMode);
    this.scene.add(this.toolbar);
    this.commentary = new CommentaryController({
      api: this.api,
      scene: this.scene,
      getPanels: () => this.panelState.panels,
      getMediaTagLookup: () => this.panelCoordinator.getMediaTagLookup(),
      getSettings: this.getSettings,
      onStateChange: (state) => this.toolbar?.setCommentaryState(state),
      onError: this.onError,
      createAudio: () => document.createElement("audio"),
    });
    this.scenePlayback = new ScenePlaybackController({
      api: this.api,
      getPanels: () => this.panelState.panels,
      applyPanelSnapshot: (snapshot) => this.panelCoordinator.applyScenePanelSnapshot(snapshot),
      removePanel: (panelId) => this.store.remove(panelId),
      applyPanelTransition: (panelId, step, progress) => {
        this.panelViews.get(panelId)?.applySceneTransition(step, progress);
      },
      clearPanelTransition: (panelId) => {
        this.panelViews.get(panelId)?.clearSceneTransition();
      },
      onStateChange: this.onSceneStateChange,
      onError: this.onError,
    });
    this.maskWorkflow = new MaskWorkflow({
      api: this.api,
      getSettings: this.getSettings,
      getPanels: () => this.panelState.panels,
      getPanel: (panelId) => this.panelCoordinator.getPanel(panelId),
      getPanelView: (panelId) => this.panelViews.get(panelId),
      getRuntimes: () => this.runtime,
      setMaskEnabled: (panelId, enabled) => this.store.setMaskEnabled(panelId, enabled),
      setAdmEnabled: (panelId, enabled) => this.store.setAdmEnabled(panelId, enabled),
      setDepthIntensity: (panelId, intensity) => this.store.setDepthIntensity(panelId, intensity),
      isSlideshowActive: (panelId) => this.panelCoordinator.runtimeFor(panelId).slideshow.active,
      stopSlideshow: (panel) => this.panelCoordinator.toggleSlideshow(panel),
      isCurrentMediaRequest: (panelId, path, generation) => (
        this.panelCoordinator.isCurrentMediaRequest(panelId, path, generation)
      ),
      getMediaGeneration: (panelId) => this.panelCoordinator.getMediaGeneration(panelId),
      onError: this.onError,
    });
    this.panelCoordinator = new PanelCoordinator({
      api: this.api,
      settings: this.getSettings,
      storage: this.storage,
      libraryId: this.libraryId,
      scene: this.scene,
      camera: this.camera,
      maskWorkflow: this.maskWorkflow,
      getEnvironmentMode: () => this.environmentMode,
      setEnvironmentMode: (mode, options) => this.setEnvironmentMode(mode, options),
      isZenMode: () => this.zenMode,
      updateControls: () => this.controls?.update(),
      onPanelsChanged: (entries, focusedId) => this.toolbar?.setPanels(entries, focusedId),
      onCompositionChanged: () => {
        if (this.panelCoordinator) this.scenePlayback.compositionChanged();
      },
      onError: this.onError,
    });
    this.scenePlayback.compositionChanged();

    this.interactions = new InteractionController({
      renderer: this.renderer,
      camera: this.camera,
      scene: this.scene,
      overlayScene: this.desktopOverlayScene,
      canvas: this.canvas,
      onActivate: (hit, context) => this.#activate(hit, context),
      onGesture: (target, gesture) => this.panelCoordinator.applyGesture(target, gesture),
      onFocus: (target) => this.panelCoordinator.focus(target),
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

  async start({ immersive }) {
    this.immersive = immersive;
    this.running = true;
    this.previewEnvironment.visible = !immersive;
    this.controls.enabled = !immersive;
    try {
      await this.panelCoordinator.refreshTagDefinitions();
    } catch (error) {
      this.onError?.(new Error(`Could not refresh tag definitions: ${error.message}`));
    }
    await this.commentary.refresh({ reportError: true });

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

    this.interactions.setRayVisible(!this.zenMode);
    if (!immersive) {
      this.panelCoordinator.setOverlayScene(this.desktopOverlayScene);
    }
    this.renderer.setAnimationLoop((time) => this.#render(time));
  }

  stop() {
    this.commentary.stop();
    if (!this.running) return;
    this.scenePlayback.stop();
    this.maskWorkflow.stop();
    this.running = false;
    this.renderer.setAnimationLoop(null);
    const session = this.renderer.xr.getSession();
    if (session) {
      session.end().catch((error) => this.onError?.(error));
    }
    this.panelCoordinator.persistNow();
  }

  dispose() {
    this.stop();
    this.commentary.dispose();
    this.scenePlayback.dispose();
    this.maskWorkflow.dispose();
    window.removeEventListener("resize", this.onResize);
    this.interactions?.dispose();
    this.controls?.dispose();
    this.panelCoordinator.dispose();
    this.toolbar?.dispose();
    this.environmentEffects?.dispose();
    disposeObject(this.previewEnvironment);
    this.renderer?.dispose();
  }

  setEnvironmentMode(mode, { persist = true } = {}) {
    this.environmentMode = normalizeEnvironmentMode(mode);
    this.environmentEffects?.setMode(this.environmentMode);
    this.toolbar?.setEnvironmentMode(this.environmentMode);
    if (persist) this.panelCoordinator?.scheduleSave();
    return this.environmentMode;
  }

  get currentEnvironmentMode() {
    return this.environmentMode;
  }

  get store() {
    return this.panelCoordinator.store;
  }

  get panelViews() {
    return this.panelCoordinator.panelViews;
  }

  get panelState() {
    return this.panelCoordinator.panelState;
  }

  get runtime() {
    return this.panelCoordinator.runtime;
  }

  get browser() {
    return this.panelCoordinator.browser;
  }

  get mediaTagLookup() {
    return this.panelCoordinator.mediaTagLookup;
  }

  get captionView() {
    return this.commentary.captionView;
  }

  // Debug/test accessors preserve the pre-controller inspection surface without
  // duplicating commentary state in the composition root.
  get commentaryEnabled() { return this.commentary.enabled; }
  get commentaryPlaying() { return this.commentary.playing; }
  get commentaryPath() { return this.commentary.path; }
  get commentaryScores() { return this.commentary.scores; }
  get commentaryAudio() { return this.commentary.audio; }
  get autoAdmStates() { return this.maskWorkflow.autoAdmStates; }
  get depthCache() { return this.maskWorkflow.depthCache; }
  get maskCache() { return this.maskWorkflow.maskCache; }
  get autoMaskStates() { return this.maskWorkflow.autoMaskStates; }
  get maskEditor() { return this.maskWorkflow.editor; }

  setZenMode(enabled) {
    this.zenMode = Boolean(enabled);
    this.toolbar?.setZenMode(this.zenMode);
    this.interactions?.setRayVisible(!this.zenMode);
    this.panelCoordinator.setZenMode(this.zenMode);
    return this.zenMode;
  }

  getSceneState() {
    return this.scenePlayback.getState();
  }

  async listScenes() {
    return this.scenePlayback.list();
  }

  async createNamedScene(name) {
    return this.scenePlayback.create(name);
  }

  async loadScene(sceneId) {
    return this.scenePlayback.load(sceneId);
  }

  resetToNewScene() {
    return this.scenePlayback.reset();
  }

  async setSceneLoop(loop) {
    return this.scenePlayback.setLoop(loop);
  }

  async setSceneShotDuration(durationSec) {
    return this.scenePlayback.setShotDuration(durationSec);
  }

  async selectSceneShot(index) {
    return this.scenePlayback.selectShot(index);
  }

  async toggleScenePlayback() {
    return this.scenePlayback.togglePlayback();
  }

  async captureOrDeleteSceneShot() {
    return this.scenePlayback.captureOrDeleteShot();
  }

  #activate(hit, context = null) {
    const { object, uv } = hit;
    const { kind, action, panelId } = object.userData;
    if (kind === "button") {
      if (object.userData.tagMenu) {
        object.userData.tagMenu.handleAction(action).catch((error) => this.onError?.(error));
      } else if (object.userData.browser) {
        object.userData.browser?.handleAction(action);
      } else if (panelId) {
        this.panelCoordinator.handleAction(panelId, action);
      } else {
        this.#toolbarAction(action);
      }
      return;
    }
    if (kind === "browser-entry") {
      object.userData.browser.activateEntry(object.userData.entry);
      return;
    }
    if (kind === "panel-surface" || kind === "panel-frame") {
      this.panelViews.get(panelId)?.activateSurface(uv, context);
    }
  }

  #toolbarAction(action) {
    if (action === "add-panel") {
      const count = this.panelState.panels.length;
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
      const { focusedId } = this.panelState;
      if (focusedId) this.store.remove(focusedId);
    } else if (action === "toggle-zen-mode") {
      this.setZenMode(!this.zenMode);
    } else if (action === "toggle-commentary") {
      if (!this.commentary.available && !this.commentary.entries.length) return;
      this.commentary.toggle().catch((error) => this.commentary.fail(error));
    } else if (action === "toggle-environment-menu") {
      this.toolbar.toggleEnvironmentMenu();
    } else if (action.startsWith("set-environment:")) {
      const mode = action.slice("set-environment:".length);
      this.setEnvironmentMode(mode);
      this.toolbar.setEnvironmentMenuOpen(false);
    } else if (action.startsWith("focus-panel:")) {
      this.store.focus(action.slice("focus-panel:".length));
    }
  }

  /** Applies the same gesture contract used by XR interactions. */
  applyGesture(target, gesture) {
    this.panelCoordinator.applyGesture(target, gesture);
  }

  #render(time) {
    this.controls.update();
    this.interactions.update();
    const viewCamera = this.renderer.xr.isPresenting
      ? this.renderer.xr.getCamera(this.camera)
      : this.camera;
    this.scenePlayback.advancePlayback(time);
    this.panelCoordinator.tick(time, viewCamera);
    this.scenePlayback.updateTransition(time);
    this.commentary.update(viewCamera);
    this.environmentEffects.render(this.renderer, this.scene, this.camera, time);
    if (!this.immersive) {
      this.renderer.clearDepth();
      this.renderer.render(this.desktopOverlayScene, this.camera);
    }
  }

  #resize() {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }
}
