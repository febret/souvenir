import * as THREE from "three";

import { mediaDisplayLayout } from "../core/media-display.js";
import {
  disposeObject,
  markInteractive,
  makeButton,
  makeCanvasTexture,
  makeLabelTexture,
  roundedRect,
} from "./canvas-ui.js";
import { MediaTexture } from "./media-texture.js";
import {
  MAX_BRUSH_SIZE,
  MAX_MASK_BLUR,
  MIN_BRUSH_SIZE,
  clampMaskBlur,
  clampBrushSize,
  opacityMapCanvas,
  surfaceUvToSourceUv,
} from "../core/erase-mask.js";
import { SpatialSlider } from "./spatial-slider.js";
import { PanelOptionsView } from "./panel-options-view.js";
import { createDisplacedPlaneGeometry } from "./depth-surface.js";

const DOUBLE_TAP_WINDOW_MS = 325;
const DOUBLE_TAP_MAX_UV_DISTANCE = 0.15;

const CONTROL_DEFINITIONS = [
  ["🎞️", "browse"],
  ["Lock", "toggle-lock"],
  ["Min", "toggle-minimize"],
  ["⚙️", "toggle-options"],
];
const PLAY_DEFINITIONS = [
  ["◀️", "previous"],
  ["⏯️", "toggle-slideshow"],
  ["▶️", "next"],
];
const CONTROL_BUTTON_WIDTH = 0.12;
const CONTROL_BUTTON_HEIGHT = 0.05;
const CONTROL_BUTTON_GAP = 0.012;
const CONTROL_ROW_WIDTH =
  4 * CONTROL_BUTTON_WIDTH + 3 * CONTROL_BUTTON_GAP;
const PANEL_UI_FRONT_BASE_Z = 0.02;
const PANEL_UI_DEPTH_CLEARANCE_Z = 0.012;
const PANEL_NUMBER_BADGE_BASE_Z = 0.02;
const PANEL_CONTROLS_BASE_Z = 0;
const PANEL_DEPTH_SLIDER_BASE_Z = 0.02;
const PANEL_EDITOR_CONTROLS_BASE_Z = 0.03;
const PANEL_OPTIONS_BASE_Z = 0.03;
const PANEL_ADM_PROMPT_BASE_Z = 0.04;
const PANEL_BRUSH_CURSOR_BASE_Z = 0.025;
const EDITOR_ACTIONS = [
  ["Eraser", "mask-erase"],
  ["Auto Mask", "mask-auto"],
  ["Clear", "mask-clear"],
  ["Cancel", "mask-cancel"],
  ["Apply", "mask-apply"],
];
function makeBlankTexture() {
  return makeCanvasTexture({
    draw(context, canvas) {
      context.fillStyle = "#111918";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = "#3b4b46";
      context.lineWidth = 4;
      context.setLineDash([12, 14]);
      roundedRect(context, 32, 32, canvas.width - 64, canvas.height - 64, 28);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = "#d8e5df";
      context.font = "600 44px system-ui, sans-serif";
      context.textAlign = "center";
      context.fillText("Choose media", canvas.width / 2, canvas.height / 2 - 12);
      context.fillStyle = "#80918b";
      context.font = "28px system-ui, sans-serif";
      context.fillText(
        "Point here, then select Media",
        canvas.width / 2,
        canvas.height / 2 + 45,
      );
    },
  });
}

/**
 * Composes one panel's media surface, interaction metadata, and feature views.
 * Expensive textures and depth geometry are updated only by their dependencies.
 */
export class PanelView extends THREE.Group {
  constructor(panel, callbacks = {}) {
    super();
    this.panel = panel;
    this.callbacks = callbacks;
    this.mediaTexture = new MediaTexture();
    this.mediaType = null;
    this.mediaSize = null;
    this.pendingImageTap = null;
    this.editorFrame = null;
    this.maskCanvas = null;
    this.maskBlur = 0;
    this.maskAvailable = false;
    this.mediaLoaded = false;
    this.maskTexture = null;
    this.alphaMapTexture = null;
    this.alphaMapCanvas = null;
    this.editorActive = false;
    this.editorBrushSize = 0.05;
    this.maskEraseMode = true;
    this.autoMaskBusy = false;
    this.brushCursorUv = null;
    this.contentUv = { repeat: { x: 1, y: 1 }, offset: { x: 0, y: 0 } };
    this.depthMapCanvas = null;
    this.maximumSurfaceDepth = 0;
    this.admEnabled = false;
    this.admBusy = false;
    this.depthIntensity = 0.35;
    this.surfaceFlatGeometry = null;
    this.admPromptVisible = false;
    this.sceneTransitionActive = false;
    this.sceneTransitionInteractiveStates = new Map();
    this.optionsOpen = false;
    this.uiVisible = true;
    this.zenMode = false;
    this.mediaTagIds = [];
    this.tagDefinitions = [];
    this.saveMode = "scale";
    this.numberBadgeSignature = "";
    this.contentLayoutSignature = "";
    this.depthGeometryState = null;
    this.name = `panel-${panel.id}`;
    this.userData.panelId = panel.id;
    this.userData.gestureTarget = panel.id;

    this.frame = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x0a0f0f, side: THREE.DoubleSide }),
    );
    this.frame.position.z = -0.008;
    markInteractive(this.frame);
    this.frame.userData.kind = "panel-frame";
    this.frame.userData.panelId = panel.id;
    this.add(this.frame);
    this.numberBadge = new THREE.Mesh(
      new THREE.PlaneGeometry(0.09, 0.05),
      new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide }),
    );
    this.numberBadge.position.set(-0.43, 0.33, 0.02);
    this.numberBadge.userData.gestureTarget = false;
    this.add(this.numberBadge);

    this.surface = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: makeBlankTexture(),
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    markInteractive(this.surface);
    this.surface.userData.kind = "panel-surface";
    this.surface.userData.panelId = panel.id;
    this.add(this.surface);
    this.surfaceFlatGeometry = this.surface.geometry;

    this.maskOverlay = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xff4f9a,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    this.maskOverlay.position.z = 0.008;
    this.maskOverlay.visible = false;
    this.add(this.maskOverlay);
    this.maskRegenerationGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.04, 1.04),
      new THREE.MeshBasicMaterial({
        color: 0x86c9ff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.maskRegenerationGlow.position.z = 0.01;
    this.maskRegenerationGlow.visible = false;
    this.add(this.maskRegenerationGlow);

    this.brushCursor = new THREE.Mesh(
      new THREE.RingGeometry(0.84, 1, 64),
      new THREE.MeshBasicMaterial({
        color: 0xff72ad,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    this.brushCursor.position.z = PANEL_BRUSH_CURSOR_BASE_Z;
    this.brushCursor.renderOrder = 20;
    this.brushCursor.visible = false;
    this.add(this.brushCursor);

    this.controls = new THREE.Group();
    this.controls.name = "controls";
    this.add(this.controls);
    this.#createControls();
    this.optionsPanel = new PanelOptionsView(this.panel.id);
    this.add(this.optionsPanel);
    this.#createAdmControls();
    this.editorControls = new THREE.Group();
    this.editorControls.name = "mask-editor-controls";
    this.editorControls.visible = false;
    this.add(this.editorControls);
    this.#createEditorControls();
    this.#createAdmPrompt();
    this.applyState(panel);
  }

  #createControls() {
    for (const [index, [label, action]] of CONTROL_DEFINITIONS.entries()) {
      const button = makeButton(label, action, {
        width: CONTROL_BUTTON_WIDTH,
        height: CONTROL_BUTTON_HEIGHT,
      });
      button.position.set(
        (index - 1.5) * (CONTROL_BUTTON_WIDTH + CONTROL_BUTTON_GAP),
        0,
        0.015,
      );
      button.userData.panelId = this.panel.id;
      button.userData.gestureTarget = false;
      this.controls.add(button);
    }
    this.playControls = new THREE.Group();
    this.playControls.position.set(0, -0.068, 0.016);
    this.playControls.userData.gestureTarget = false;
    this.controls.add(this.playControls);
    for (const [index, [label, action]] of PLAY_DEFINITIONS.entries()) {
      const button = makeButton(label, action, {
        width: 0.102,
        height: 0.042,
        textureWidth: 260,
      });
      button.position.set((index - 1) * 0.105, 0, 0);
      button.userData.panelId = this.panel.id;
      button.userData.gestureTarget = false;
      this.playControls.add(button);
    }
  }

  #refreshOptionsPanel(width = this.panel?.dimensions?.width ?? 1.2, height = this.panel?.dimensions?.height ?? 0.8) {
    const rebuilt = this.optionsPanel.update({
      width,
      height,
      saveMode: this.saveMode,
      tagDefinitions: this.tagDefinitions,
      mediaTagIds: this.mediaTagIds,
      depthOffset: PANEL_OPTIONS_BASE_Z + this.#uiDepthOffset(),
    });
    if (rebuilt) this.#updateControlStates();
  }

  #createEditorControls() {
    this.brushSlider = new SpatialSlider({
      title: "Brush",
      action: "mask-brush-slider",
      min: MIN_BRUSH_SIZE,
      max: MAX_BRUSH_SIZE,
      step: 0.01,
      value: this.editorBrushSize,
      width: 0.36,
      formatValue: (value) => `${Math.round(value * 100)}%`,
      onChange: (value) => this.callbacks.onMaskSetting?.(
        this.panel.id,
        "brushSize",
        value,
      ),
    });
    this.brushSlider.position.set(-0.19, 0.025, 0.02);
    this.brushSlider.track.userData.panelId = this.panel.id;
    this.editorControls.add(this.brushSlider);

    this.blurSlider = new SpatialSlider({
      title: "Blur",
      action: "mask-blur-slider",
      min: 0,
      max: MAX_MASK_BLUR,
      step: 1,
      value: this.maskBlur,
      width: 0.36,
      formatValue: (value) => `${value}px`,
      onChange: (value) => this.callbacks.onMaskSetting?.(
        this.panel.id,
        "blur",
        value,
      ),
    });
    this.blurSlider.position.set(0.19, 0.025, 0.02);
    this.blurSlider.track.userData.panelId = this.panel.id;
    this.editorControls.add(this.blurSlider);

    for (const [index, [label, action]] of EDITOR_ACTIONS.entries()) {
      const button = makeButton(label, action, {
        width: 0.115,
        height: 0.044,
        textureWidth: 420,
      });
      button.position.set(
        (index - 2) * 0.13,
        -0.045,
        0.02,
      );
      button.userData.panelId = this.panel.id;
      button.userData.gestureTarget = false;
      this.editorControls.add(button);
    }
  }

  #createAdmControls() {
    this.depthSlider = new SpatialSlider({
      title: "Depth",
      action: "adm-depth-slider",
      min: 0,
      max: 3,
      step: 0.05,
      value: this.depthIntensity,
      width: 0.36,
      formatValue: (value) => `${value.toFixed(2)}x`,
      onChange: (value) => this.callbacks.onAdmSetting?.(
        this.panel.id,
        "depthIntensity",
        value,
      ),
    });
    this.depthSlider.track.userData.panelId = this.panel.id;
    this.depthSlider.position.set(0, -0.37, PANEL_DEPTH_SLIDER_BASE_Z);
    this.add(this.depthSlider);
  }

  #createAdmPrompt() {
    this.admPrompt = new THREE.Group();
    this.admPrompt.visible = false;
    this.admPrompt.position.set(0, 0, PANEL_ADM_PROMPT_BASE_Z);
    const background = new THREE.Mesh(
      new THREE.PlaneGeometry(0.72, 0.28),
      new THREE.MeshBasicMaterial({
        color: 0x111918,
        transparent: true,
        opacity: 0.96,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    this.admPrompt.add(background);
    this.admPromptLabel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.64, 0.11),
      new THREE.MeshBasicMaterial({
        map: makeLabelTexture("Generate depth data for this image?", { width: 1200, height: 200 }),
        transparent: true,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    this.admPromptLabel.position.set(0, 0.06, 0.002);
    this.admPrompt.add(this.admPromptLabel);
    const yes = makeButton("Generate", "adm-generate-confirm", {
      width: 0.22,
      height: 0.06,
      textureWidth: 720,
    });
    yes.position.set(-0.13, -0.07, 0.003);
    yes.userData.panelId = this.panel.id;
    yes.userData.gestureTarget = false;
    this.admPrompt.add(yes);
    const no = makeButton("Not now", "adm-generate-cancel", {
      width: 0.22,
      height: 0.06,
      textureWidth: 720,
    });
    no.position.set(0.13, -0.07, 0.003);
    no.userData.panelId = this.panel.id;
    no.userData.gestureTarget = false;
    this.admPrompt.add(no);
    this.add(this.admPrompt);
  }

  applyState(panel) {
    this.panel = panel;
    this.admEnabled = Boolean(panel.admEnabled);
    this.saveMode = typeof panel.saveMode === "string" ? panel.saveMode : "scale";
    this.depthIntensity = Math.max(0, Math.min(3, Number(panel.depthIntensity) || 0.35));
    const minimized = Boolean(panel.minimized);
    if (minimized) this.optionsOpen = false;
    const width =
      minimized ? 0.3 : panel.width ?? panel.dimensions?.width ?? panel.size?.width ?? 0.95;
    const height =
      minimized ? 0.18 : panel.height ?? panel.dimensions?.height ?? panel.size?.height ?? 0.58;
    this.frame.scale.set(width + 0.025, height + 0.025, 1);
    this.numberBadge.position.set(-width / 2 + 0.08, height / 2 - 0.04, PANEL_NUMBER_BADGE_BASE_Z);
    const numberBadgeSignature = `${panel.number ?? "?"}:${panel.color ?? "#9be7b5"}`;
    if (numberBadgeSignature !== this.numberBadgeSignature) {
      this.numberBadgeSignature = numberBadgeSignature;
      this.numberBadge.material.map?.dispose?.();
      this.numberBadge.material.map = makeLabelTexture(String(panel.number ?? "?"), {
        width: 180,
        height: 100,
        font: "700 44px system-ui, sans-serif",
        background: panel.color ?? "#9be7b5",
        border: "#0f1b18",
        foreground: "#0c1714",
      });
      this.numberBadge.material.needsUpdate = true;
    }
    this.controls.visible = this.uiVisible && !minimized && Boolean(panel.focused ?? true);
    const controlScale = Math.min(1, Math.max(0.3, (width - 0.025) / CONTROL_ROW_WIDTH));
    this.controls.scale.setScalar(controlScale);
    this.controls.position.set(0, height / 2 + 0.07, PANEL_CONTROLS_BASE_Z);
    this.depthSlider.position.set(0, -height / 2 - 0.08, PANEL_DEPTH_SLIDER_BASE_Z);
    this.depthSlider.setValue(this.depthIntensity);
    this.editorControls.scale.setScalar(Math.min(1, Math.max(0.35, (width - 0.02) / 0.78)));
    this.editorControls.position.set(0, -height / 2 + 0.09, PANEL_EDITOR_CONTROLS_BASE_Z);
    this.editorControls.visible = this.uiVisible && this.editorActive && !minimized;

    const position = panel.position ?? panel.transform?.position;
    const rotation = panel.rotation ?? panel.transform?.rotation;
    if (position) {
      this.position.set(position.x ?? 0, position.y ?? 1.35, position.z ?? -1.5);
    }
    if (rotation) {
      this.rotation.set(rotation.x ?? 0, rotation.y ?? 0, rotation.z ?? 0);
    }
    this.userData.locked = Boolean(panel.locked || this.zenMode);
    this.userData.minimized = minimized;
    const normalDimensions = panel.restoreDimensions ?? panel.dimensions ?? { width, height };
    const scaleLimits = minimized
      ? { min: 1, max: 1 }
      : {
        min: Math.max(0.2 / normalDimensions.width, 0.15 / normalDimensions.height),
        max: Math.min(5 / normalDimensions.width, 5 / normalDimensions.height),
      };
    this.userData.manipulation = {
      type: "panel",
      scalable: !minimized && !this.userData.locked,
      dimensions: { width, height },
      initialDimensions: {
        width: normalDimensions.width,
        height: normalDimensions.height,
      },
      scaleLimits,
    };

    this.#updateControlStates();
    this.#applyDepthGeometry();
    this.#refreshOptionsPanel(width, height);
    this.optionsPanel.visible = this.uiVisible
      && this.optionsOpen
      && !minimized
      && Boolean(panel.focused ?? true)
      && !this.zenMode;

    this.#applyContentTransform(width, height);
    this.#applyUiDepthOffset();
  }

  #applyContentTransform(panelWidth, panelHeight) {
    const texture = this.surface.material.map;
    if (!texture) return;
    const signature = [
      panelWidth,
      panelHeight,
      this.mediaSize?.width ?? 0,
      this.mediaSize?.height ?? 0,
      texture.uuid,
    ].join(":");
    if (signature === this.contentLayoutSignature) return;
    this.contentLayoutSignature = signature;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    if (!this.mediaSize) {
      this.surface.scale.set(panelWidth, panelHeight, 1);
      this.surface.position.set(0, 0, 0);
      this.maskOverlay.scale.copy(this.surface.scale);
      this.maskOverlay.position.set(0, 0, 0.008);
      this.maskRegenerationGlow.scale.set(
        this.surface.scale.x * 1.03,
        this.surface.scale.y * 1.03,
        1,
      );
      this.maskRegenerationGlow.position.set(0, 0, 0.01);
      texture.repeat.set(1, 1);
      texture.offset.set(0, 0);
      this.contentUv = { repeat: { x: 1, y: 1 }, offset: { x: 0, y: 0 } };
      this.#syncMaskTransforms();
      return;
    }
    const layout = mediaDisplayLayout({
      sourceWidth: this.mediaSize.width,
      sourceHeight: this.mediaSize.height,
      panelWidth,
      panelHeight,
    });
    this.surface.scale.set(layout.surface.width, layout.surface.height, 1);
    this.surface.position.set(layout.position.x, layout.position.y, 0);
    this.maskOverlay.scale.copy(this.surface.scale);
    this.maskOverlay.position.set(layout.position.x, layout.position.y, 0.008);
    this.maskRegenerationGlow.scale.set(
      this.surface.scale.x * 1.03,
      this.surface.scale.y * 1.03,
      1,
    );
    this.maskRegenerationGlow.position.set(layout.position.x, layout.position.y, 0.01);
    texture.repeat.set(layout.uv.repeat.x, layout.uv.repeat.y);
    texture.offset.set(layout.uv.offset.x, layout.uv.offset.y);
    texture.needsUpdate = true;
    this.contentUv = {
      repeat: { ...layout.uv.repeat },
      offset: { ...layout.uv.offset },
    };
    this.#syncMaskTransforms();
    if (this.brushCursorUv) this.#showBrushCursor(this.brushCursorUv);
  }

  setFocused(focused) {
    this.controls.visible = this.uiVisible && focused && !this.panel.minimized && !this.editorActive && !this.zenMode;
    this.editorControls.visible = this.uiVisible && focused && !this.panel.minimized && this.editorActive;
    this.depthSlider.visible = this.uiVisible && focused && !this.panel.minimized
      && this.mediaType === "image" && this.optionsOpen && !this.zenMode;
    this.optionsPanel.visible = this.uiVisible && focused && this.optionsOpen && !this.panel.minimized && !this.zenMode;
    const frameColor = new THREE.Color(this.panel.color ?? "#9be7b5").getHex();
    this.frame.material.color.set(frameColor);
    this.#updateFrameVisibility();
  }

  setUiVisible(visible) {
    this.uiVisible = Boolean(visible);
    this.setFocused(Boolean(this.panel?.focused ?? true));
  }

  setZenMode(zen) {
    this.zenMode = Boolean(zen);
    this.uiVisible = !this.zenMode;
    this.applyState(this.panel);
    this.setFocused(Boolean(this.panel?.focused ?? true));
  }

  async showMedia(item, url, options = {}) {
    this.#clearPendingImageTap();
    this.hideAdmPrompt();
    this.mediaType = null;
    this.mediaSize = null;
    this.mediaLoaded = false;
    this.#updateControlStates();
    const previousMap = this.surface.material.map;
    try {
      const result = await this.mediaTexture.load(item, url, options);
      if (!result) return null;
      this.surface.material.map = result.texture;
      this.surface.material.color.set(0xffffff);
      this.surface.material.needsUpdate = true;
      previousMap?.dispose();
      this.mediaType = result.type;
      this.mediaLoaded = true;
      this.mediaSize = {
        width: result.naturalWidth ?? result.width,
        height: result.naturalHeight ?? result.height,
      };
      const width = this.panel.minimized
        ? 0.3 : this.panel.width ?? this.panel.dimensions?.width ?? this.panel.size?.width ?? 0.95;
      const height = this.panel.minimized
        ? 0.18 : this.panel.height ?? this.panel.dimensions?.height ?? this.panel.size?.height ?? 0.58;
      this.#applyContentTransform(width, height);
      this.#applyDepthGeometry();
      if (result.media) {
        result.media.addEventListener("ended", () => {
          this.callbacks.onVideoEnded?.(this.panel.id);
        });
      }
      return result;
    } catch (error) {
      this.callbacks.onError?.(error);
      return null;
    }
  }

  setMaskAvailable(available) {
    this.maskAvailable = Boolean(available);
    this.#updateControlStates();
  }

  setMediaLoaded(loaded) {
    this.mediaLoaded = Boolean(loaded);
    this.#updateControlStates();
  }

  setTagDefinitions(definitions) {
    this.tagDefinitions = Array.isArray(definitions) ? definitions : [];
    this.#refreshOptionsPanel();
  }

  setMediaTagSelection(tagIds) {
    this.mediaTagIds = Array.isArray(tagIds) ? [...tagIds] : [];
    this.#refreshOptionsPanel();
  }

  toggleMediaTags(definitions, tagIds) {
    this.tagDefinitions = Array.isArray(definitions) ? definitions : [];
    this.mediaTagIds = Array.isArray(tagIds) ? [...tagIds] : [];
    this.optionsOpen = true;
    this.#refreshOptionsPanel();
    this.setFocused(true);
    return this.optionsOpen;
  }

  toggleOptions() {
    this.optionsOpen = !this.optionsOpen;
    this.setFocused(true);
    this.#updateControlStates();
    return this.optionsOpen;
  }

  getMediaDimensions() {
    return this.mediaSize ? { ...this.mediaSize } : null;
  }

  setMask(maskCanvas, { blur = 0, enabled = true } = {}) {
        const changedCanvas = this.maskCanvas !== maskCanvas;
        this.maskCanvas = maskCanvas ?? null;
        this.maskBlur = clampMaskBlur(blur);
        this.maskAvailable = Boolean(maskCanvas);
        if (!this.maskCanvas) {
          this.#clearMaskTextures();
          this.#updateControlStates();
          return;
        }
        if (changedCanvas && this.maskTexture) this.#clearMaskTextures();
        this.#ensureMaskTextures();
        this.#updateMaskTextures();
        const material = this.surface.material;
        material.alphaMap = enabled ? this.alphaMapTexture : null;
        material.transparent = Boolean(enabled);
        material.alphaTest = enabled ? 0.01 : 0;
        material.depthWrite = !enabled;
        material.needsUpdate = true;
        this.#updateFrameVisibility();
        this.#updateControlStates();
  }

  beginMaskEditor(maskCanvas, { brushSize, blur, erase = true, autoMaskBusy = false } = {}) {
        this.editorActive = true;
        this.optionsOpen = false;
        const changedCanvas = this.maskCanvas !== maskCanvas;
        this.maskCanvas = maskCanvas;
        this.maskBlur = clampMaskBlur(blur);
        this.maskEraseMode = erase !== false;
        this.maskAvailable = true;
        this.surface.userData.gestureTarget = false;
        this.frame.userData.gestureTarget = false;
        this.userData.maskEditing = true;
        this.surface.userData.drawTarget = {
          onDraw: (phase, uv) => this.callbacks.onMaskDraw?.(
            this.panel.id,
            phase,
            surfaceUvToSourceUv(uv, this.contentUv),
          ),
          onHover: (uv) => this.#showBrushCursor(uv),
          onLeave: () => this.#hideBrushCursor(),
        };
        if (changedCanvas && this.maskTexture) this.#clearMaskTextures();
        this.#ensureMaskTextures();
        this.#updateMaskTextures();
        this.maskOverlay.visible = true;
        this.#updateEditorControls(brushSize, this.maskBlur, { autoMaskBusy, erase: this.maskEraseMode });
        this.setFocused(true);
  }

  updateMaskEditor(maskCanvas, { brushSize, blur, erase = this.maskEraseMode, autoMaskBusy = this.autoMaskBusy } = {}) {
        if (!this.editorActive) return;
        this.maskCanvas = maskCanvas;
        this.maskBlur = clampMaskBlur(blur);
        this.maskEraseMode = erase !== false;
        this.#updateEditorControls(brushSize, this.maskBlur, { autoMaskBusy, erase: this.maskEraseMode });
        this.maskTexture.needsUpdate = true;
        if (this.editorFrame == null) {
          this.editorFrame = requestAnimationFrame(() => {
            this.editorFrame = null;
            this.#updateMaskTextures({ updateAlpha: false });
          });
        }
  }

  endMaskEditor() {
        this.editorActive = false;
        this.autoMaskBusy = false;
        this.surface.userData.gestureTarget = undefined;
        this.frame.userData.gestureTarget = undefined;
        this.surface.userData.drawTarget = undefined;
        this.userData.maskEditing = false;
        this.maskOverlay.visible = false;
        this.maskOverlay.material.color.set(0xff4f9a);
        this.maskOverlay.material.opacity = 0.42;
        this.maskRegenerationGlow.visible = false;
        this.maskRegenerationGlow.material.opacity = 0;
        this.#hideBrushCursor();
        this.editorControls.visible = false;
        this.controls.visible = this.uiVisible && !this.panel.minimized && !this.zenMode;
  }

  #updateControlStates() {
        for (const control of this.controls.children) {
          if (control === this.playControls) continue;
          if (!control.material?.color) continue;
          const action = control.userData.action;
          const inactive = this.admPromptVisible;
          const tagInactive = false;
          const active =
            (action === "toggle-lock" && this.panel.locked) ||
            (action === "toggle-options" && this.optionsOpen);
          control.material.color.set((inactive || tagInactive) ? 0x5f6b67 : active ? 0xaaf1c3 : 0xffffff);
        }
        if (this.playControls) {
          for (const control of this.playControls.children) {
            const action = control.userData.action;
            const active = action === "toggle-slideshow" && this.panel.slideshow?.playing;
            control.material.color.set(active ? 0xaaf1c3 : 0xffffff);
          }
        }
        this.optionsPanel.updateControlStates({
          maskAvailable: this.maskAvailable,
          mediaLoaded: this.mediaLoaded,
          mediaType: this.mediaType,
          maskEnabled: this.panel.maskEnabled,
          admEnabled: this.admEnabled,
          admPromptVisible: this.admPromptVisible,
        });
        const sliderInteractive = this.admEnabled && this.mediaType === "image" && !this.admBusy;
        this.depthSlider.track.userData.interactive = sliderInteractive;
        this.depthSlider.track.material.color.set(sliderInteractive ? 0xffffff : 0x7f8b88);
  }

  setAdmState({ enabled, intensity, busy = this.admBusy } = {}) {
    this.admEnabled = Boolean(enabled);
    this.depthIntensity = Math.max(0, Math.min(3, Number(intensity) || 0.35));
    this.admBusy = Boolean(busy);
    this.depthSlider.setValue(this.depthIntensity);
    this.#applyDepthGeometry();
    this.#updateControlStates();
  }

  setDepthMap(depthCanvas) {
    this.depthMapCanvas = depthCanvas ?? null;
    this.#applyDepthGeometry();
    this.#updateControlStates();
  }

  showAdmPrompt() {
    this.admPromptVisible = true;
    this.admPrompt.visible = true;
    this.#updateControlStates();
  }

  hideAdmPrompt() {
    this.admPromptVisible = false;
    this.admPrompt.visible = false;
    this.#updateControlStates();
  }

  #applyDepthGeometry() {
    if (!this.surface) return;
    const shouldDisplace = this.admEnabled && this.mediaType === "image" && this.depthMapCanvas;
    const nextState = {
      canvas: this.depthMapCanvas,
      enabled: Boolean(shouldDisplace),
      intensity: this.depthIntensity,
      mediaType: this.mediaType,
    };
    const previous = this.depthGeometryState;
    if (previous
      && previous.canvas === nextState.canvas
      && previous.enabled === nextState.enabled
      && previous.intensity === nextState.intensity
      && previous.mediaType === nextState.mediaType) {
      return;
    }
    this.depthGeometryState = nextState;
    if (!shouldDisplace) {
      this.maximumSurfaceDepth = 0;
      if (this.surface.geometry !== this.surfaceFlatGeometry) {
        this.surface.geometry.dispose();
        this.surface.geometry = this.surfaceFlatGeometry;
      }
      this.#applyUiDepthOffset();
      return;
    }
    if (this.surface.geometry !== this.surfaceFlatGeometry) {
      this.surface.geometry.dispose();
    }
    const { geometry, maximumDepth } = createDisplacedPlaneGeometry(
      this.depthMapCanvas,
      this.depthIntensity,
      this.depthMapCanvas?.userData?.gridSegments,
    );
    this.surface.geometry = geometry;
    this.maximumSurfaceDepth = maximumDepth;
    this.#applyUiDepthOffset();
  }

  #uiDepthOffset() {
    const maximumSurfaceDepth = Math.max(0, Number(this.maximumSurfaceDepth) || 0);
    return Math.max(0, maximumSurfaceDepth + PANEL_UI_DEPTH_CLEARANCE_Z - PANEL_UI_FRONT_BASE_Z);
  }

  #applyUiDepthOffset() {
    const offset = this.#uiDepthOffset();
    if (this.numberBadge) this.numberBadge.position.z = PANEL_NUMBER_BADGE_BASE_Z + offset;
    if (this.controls) this.controls.position.z = PANEL_CONTROLS_BASE_Z + offset;
    if (this.depthSlider) this.depthSlider.position.z = PANEL_DEPTH_SLIDER_BASE_Z + offset;
    if (this.editorControls) this.editorControls.position.z = PANEL_EDITOR_CONTROLS_BASE_Z + offset;
    if (this.optionsPanel) this.optionsPanel.position.z = PANEL_OPTIONS_BASE_Z + offset;
    if (this.admPrompt) this.admPrompt.position.z = PANEL_ADM_PROMPT_BASE_Z + offset;
    if (this.brushCursor) this.brushCursor.position.z = PANEL_BRUSH_CURSOR_BASE_Z + offset;
  }

  #updateEditorControls(brushSize, blur, { erase = this.maskEraseMode, autoMaskBusy = this.autoMaskBusy } = {}) {
        this.editorBrushSize = clampBrushSize(brushSize);
        this.maskEraseMode = erase !== false;
        this.autoMaskBusy = Boolean(autoMaskBusy);
        const sliderInteractive = this.editorActive && !this.autoMaskBusy;
        this.brushSlider.track.userData.interactive = sliderInteractive;
        this.blurSlider.track.userData.interactive = sliderInteractive;
        this.brushSlider.track.material.color.set(sliderInteractive ? 0xffffff : 0x7f8b88);
        this.blurSlider.track.material.color.set(sliderInteractive ? 0xffffff : 0x7f8b88);
        for (const control of this.editorControls.children) {
          const action = control.userData?.action;
          if (!action || action === "mask-brush-slider" || action === "mask-blur-slider") continue;
          const inactive = this.autoMaskBusy && action !== "mask-auto";
          control.userData.interactive = !inactive;
          const active = action === "mask-erase" && this.maskEraseMode;
          control.material.color.set(inactive ? 0x64716e : active ? 0xaaf1c3 : 0xffffff);
        }
        if (this.autoMaskBusy) {
          this.maskOverlay.material.color.set(0xb0b9be);
          this.maskOverlay.material.opacity = 0.32;
          this.maskRegenerationGlow.visible = true;
        } else {
          this.maskOverlay.material.color.set(0xff4f9a);
          this.maskOverlay.material.opacity = 0.42;
          this.maskRegenerationGlow.visible = false;
          this.maskRegenerationGlow.material.opacity = 0;
        }
        this.maskOverlay.material.needsUpdate = true;
        this.maskRegenerationGlow.material.needsUpdate = true;
        this.brushSlider.setValue(this.editorBrushSize);
        this.blurSlider.setValue(clampMaskBlur(blur));
        if (this.autoMaskBusy) this.#hideBrushCursor();
        else if (this.brushCursorUv) this.#showBrushCursor(this.brushCursorUv);
  }

  #showBrushCursor(uv) {
        if (!this.editorActive || !this.maskCanvas || this.autoMaskBusy) return;
        this.brushCursorUv = { x: uv.x, y: uv.y };
        const minimum = Math.min(this.maskCanvas.width, this.maskCanvas.height);
        const radiusX = (this.editorBrushSize * minimum) / (2 * this.maskCanvas.width);
        const radiusY = (this.editorBrushSize * minimum) / (2 * this.maskCanvas.height);
        const repeatX = Math.max(Math.abs(this.contentUv.repeat.x), 1e-6);
        const repeatY = Math.max(Math.abs(this.contentUv.repeat.y), 1e-6);
        this.brushCursor.position.set(
          this.surface.position.x + (uv.x - 0.5) * this.surface.scale.x,
          this.surface.position.y + (uv.y - 0.5) * this.surface.scale.y,
          PANEL_BRUSH_CURSOR_BASE_Z + this.#uiDepthOffset(),
        );
        this.brushCursor.scale.set(
          (this.surface.scale.x * radiusX) / repeatX,
          (this.surface.scale.y * radiusY) / repeatY,
          1,
        );
        this.brushCursor.visible = true;
  }

  #hideBrushCursor() {
        this.brushCursorUv = null;
        this.brushCursor.visible = false;
  }

  #ensureMaskTextures() {
        if (this.maskTexture && this.alphaMapTexture) return;
        this.maskTexture = new THREE.CanvasTexture(this.maskCanvas);
        this.maskTexture.colorSpace = THREE.NoColorSpace;
        this.maskTexture.wrapS = THREE.ClampToEdgeWrapping;
        this.maskTexture.wrapT = THREE.ClampToEdgeWrapping;
        this.alphaMapCanvas = opacityMapCanvas(this.maskCanvas, this.maskBlur);
        this.alphaMapTexture = new THREE.CanvasTexture(this.alphaMapCanvas);
        this.alphaMapTexture.colorSpace = THREE.NoColorSpace;
        this.alphaMapTexture.wrapS = THREE.ClampToEdgeWrapping;
        this.alphaMapTexture.wrapT = THREE.ClampToEdgeWrapping;
        this.maskOverlay.material.map = this.maskTexture;
        this.#syncMaskTransforms();
  }

  #updateMaskTextures({ updateAlpha = true } = {}) {
        if (!this.maskCanvas) return;
        this.#ensureMaskTextures();
        this.maskTexture.needsUpdate = true;
        if (updateAlpha) {
          const opacity = opacityMapCanvas(this.maskCanvas, this.maskBlur);
          const context = this.alphaMapCanvas.getContext("2d");
          context.clearRect(0, 0, this.alphaMapCanvas.width, this.alphaMapCanvas.height);
          context.drawImage(opacity, 0, 0);
          this.alphaMapTexture.needsUpdate = true;
        }
  }

  #syncMaskTransforms() {
        for (const texture of [this.maskTexture, this.alphaMapTexture]) {
          if (!texture) continue;
          texture.repeat.set(this.contentUv.repeat.x, this.contentUv.repeat.y);
          texture.offset.set(this.contentUv.offset.x, this.contentUv.offset.y);
          texture.needsUpdate = true;
        }
  }

  #clearMaskTextures() {
        const material = this.surface.material;
        if (material.alphaMap === this.alphaMapTexture) material.alphaMap = null;
        material.transparent = false;
        material.alphaTest = 0;
        material.depthWrite = true;
        material.needsUpdate = true;
        this.maskOverlay.material.map = null;
        this.maskTexture?.dispose();
        this.alphaMapTexture?.dispose();
        this.maskTexture = null;
        this.alphaMapTexture = null;
        this.alphaMapCanvas = null;
        this.maskOverlay.visible = false;
        this.#updateFrameVisibility();
  }

  #updateFrameVisibility() {
    const material = this.surface.material;
    this.frame.visible = !(material.alphaMap && material.transparent);
  }

  /**
   * Returns the current image's natural dimensions, never video metadata.
   */
  getNativeImageDimensions() {
    if (
      this.mediaType !== "image" ||
      !Number.isFinite(this.mediaSize?.width) ||
      !Number.isFinite(this.mediaSize?.height) ||
      this.mediaSize.width <= 0 ||
      this.mediaSize.height <= 0
    ) {
      return null;
    }
    return { ...this.mediaSize };
  }

  activateSurface(uv) {
    if (this.panel.minimized) {
      this.callbacks.onAction?.(this.panel.id, "toggle-minimize");
      return;
    }
    if (!this.panel.media?.selectedId && !this.panel.currentMedia) {
      this.callbacks.onAction?.(this.panel.id, "browse");
      return;
    }
    if (this.userData.locked) {
      this.callbacks.onAction?.(this.panel.id, "next");
      return;
    }
    if (this.mediaType === "image") {
      this.#queueImageTap(uv);
      return;
    }
    this.#activateSingle(uv);
  }

  #activateSingle(uv, queuedImage = false) {
    if (queuedImage || this.mediaType === "image") {
      this.callbacks.onAction?.(this.panel.id, (uv?.x ?? 0.5) < 0.5 ? "previous" : "next");
      return;
    }
    if (this.mediaTexture.video) {
      if (this.mediaTexture.video.paused) {
        this.mediaTexture.play().catch(this.callbacks.onError);
      } else {
        this.mediaTexture.pause();
      }
    }
  }

  #queueImageTap(uv) {
    const point = { x: uv?.x ?? 0.5, y: uv?.y ?? 0.5 };
    const now = performance.now();
    const pending = this.pendingImageTap;
    if (pending) {
      const elapsed = now - pending.time;
      const distance = Math.hypot(point.x - pending.uv.x, point.y - pending.uv.y);
      if (elapsed <= DOUBLE_TAP_WINDOW_MS && distance <= DOUBLE_TAP_MAX_UV_DISTANCE) {
        this.#clearPendingImageTap();
        this.#activateSingle(point, true);
        return;
      }
      this.#clearPendingImageTap({ triggerSingle: true });
    }
    this.pendingImageTap = { time: now, uv: point };
    this.pendingImageTap.timer = setTimeout(() => {
      const completed = this.pendingImageTap;
      this.pendingImageTap = null;
      if (completed) this.#activateSingle(completed.uv);
    }, DOUBLE_TAP_WINDOW_MS);
  }

  #clearPendingImageTap({ triggerSingle = false } = {}) {
    const pending = this.pendingImageTap;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingImageTap = null;
    if (triggerSingle) this.#activateSingle(pending.uv, true);
  }

  dispose() {
    this.#clearPendingImageTap();
    if (this.editorFrame != null) cancelAnimationFrame(this.editorFrame);
    this.#clearMaskTextures();
    if (this.surface.geometry !== this.surfaceFlatGeometry) {
      this.surface.geometry.dispose();
      this.surface.geometry = this.surfaceFlatGeometry;
    }
    this.mediaTexture.dispose();
    disposeObject(this);
  }

  tick(time) {
    if (!this.editorActive || !this.autoMaskBusy) return;
    const wave = 0.5 + 0.5 * Math.sin((Number(time) || 0) * 0.008);
    this.maskRegenerationGlow.material.opacity = 0.1 + wave * 0.26;
    this.maskRegenerationGlow.material.needsUpdate = true;
    const autoButton = this.editorControls.children.find(
      (control) => control.userData?.action === "mask-auto",
    );
    if (autoButton) {
      const blend = 0.35 + wave * 0.65;
      autoButton.material.color.setRGB(1, blend, 1);
      autoButton.material.needsUpdate = true;
    }
  }

  applySceneTransition(transition, progress) {
    const alpha = Math.max(0, Math.min(1, Number(progress) || 0));
    const from = transition?.from;
    const to = transition?.to;
    if (from?.transform && to?.transform) {
      const fromQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        from.transform.rotation.x,
        from.transform.rotation.y,
        from.transform.rotation.z,
      ));
      const toQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        to.transform.rotation.x,
        to.transform.rotation.y,
        to.transform.rotation.z,
      ));
      const rotation = new THREE.Euler().setFromQuaternion(
        fromQuaternion.slerp(toQuaternion, alpha),
      );
      const blended = {
        ...this.panel,
        transform: {
          position: {
            x: from.transform.position.x + (to.transform.position.x - from.transform.position.x) * alpha,
            y: from.transform.position.y + (to.transform.position.y - from.transform.position.y) * alpha,
            z: from.transform.position.z + (to.transform.position.z - from.transform.position.z) * alpha,
          },
          rotation: {
            x: rotation.x,
            y: rotation.y,
            z: rotation.z,
          },
        },
        dimensions: {
          width: from.dimensions.width + (to.dimensions.width - from.dimensions.width) * alpha,
          height: from.dimensions.height + (to.dimensions.height - from.dimensions.height) * alpha,
        },
      };
      this.applyState(blended);
    }
    const opacity = (transition?.fromAlpha ?? 1) + ((transition?.toAlpha ?? 1) - (transition?.fromAlpha ?? 1)) * alpha;
    this.#setOpacity(opacity);
    this.traverse((object) => {
      if (!Object.prototype.hasOwnProperty.call(object.userData ?? {}, "interactive")) return;
      if (!this.sceneTransitionInteractiveStates.has(object)) {
        this.sceneTransitionInteractiveStates.set(object, object.userData.interactive);
      }
      object.userData.interactive = false;
    });
    this.sceneTransitionActive = true;
  }

  clearSceneTransition() {
    if (!this.sceneTransitionActive) return;
    this.sceneTransitionActive = false;
    this.#setOpacity(1);
    for (const [object, interactive] of this.sceneTransitionInteractiveStates) {
      object.userData.interactive = interactive;
    }
    this.sceneTransitionInteractiveStates.clear();
  }

  #setOpacity(alpha) {
    const clamped = Math.max(0, Math.min(1, Number(alpha) || 0));
    this.traverse((object) => {
      const materials = Array.isArray(object.material)
        ? object.material
        : object.material
          ? [object.material]
          : [];
      for (const material of materials) {
        if (!material || typeof material !== "object") continue;
        if (!Object.prototype.hasOwnProperty.call(material.userData ?? {}, "baseOpacity")) {
          material.userData = material.userData ?? {};
          material.userData.baseOpacity = Number.isFinite(material.opacity) ? material.opacity : 1;
        }
        const baseOpacity = material.userData.baseOpacity;
        material.transparent = clamped < 1 || baseOpacity < 1 || Boolean(material.transparent);
        material.opacity = baseOpacity * clamped;
        material.needsUpdate = true;
      }
    });
  }
}
