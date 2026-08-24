import * as THREE from "three";

import { ASPECT_RATIO_MODES, normalizeAspectRatioMode } from "../core/aspect-ratio.js";
import { mediaDisplayLayout, normalizeDisplayMode } from "../core/media-display.js";
import {
  disposeObject,
  makeButton,
  makeCanvasTexture,
  makeLabelTexture,
  roundedRect,
} from "./canvas-ui.js";
import { MediaTexture } from "./media-texture.js";
import { TagMenu } from "./tag-menu.js";
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

const DOUBLE_TAP_WINDOW_MS = 325;
const DOUBLE_TAP_MAX_UV_DISTANCE = 0.15;

const CONTROL_DEFINITIONS = [
  ["Media", "browse"],
  ["Lock", "toggle-lock"],
  ["Min", "toggle-minimize"],
  ["Play", "toggle-slideshow"],
  ["Zoom", "toggle-zoom"],
  ["Ratio", "cycle-aspect-ratio"],
  ["Erase BG", "edit-erase-mask"],
  ["Mask", "toggle-mask"],
  ["Tags", "toggle-media-tags"],
];
const CONTROL_BUTTON_WIDTH = 0.135;
const CONTROL_BUTTON_HEIGHT = 0.05;
const CONTROL_BUTTON_GAP = 0.012;
const CONTROL_ROW_WIDTH =
  3 * CONTROL_BUTTON_WIDTH + 2 * CONTROL_BUTTON_GAP;
const EDITOR_ACTIONS = [
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

export class PanelView extends THREE.Group {
  constructor(panel, callbacks = {}) {
    super();
    this.panel = panel;
    this.callbacks = callbacks;
    this.mediaTexture = new MediaTexture();
    this.mediaType = null;
    this.mediaSize = null;
    this.pendingImageTap = null;
    this.modeIndicatorTimer = null;
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
    this.brushCursorUv = null;
    this.contentUv = { repeat: { x: 1, y: 1 }, offset: { x: 0, y: 0 } };
    this.name = `panel-${panel.id}`;
    this.userData.panelId = panel.id;
    this.userData.gestureTarget = panel.id;

    this.frame = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x0a0f0f, side: THREE.DoubleSide }),
    );
    this.frame.position.z = -0.008;
    this.frame.userData.interactive = true;
    this.frame.userData.kind = "panel-frame";
    this.frame.userData.panelId = panel.id;
    this.add(this.frame);

    this.surface = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: makeBlankTexture(),
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    this.surface.userData.interactive = true;
    this.surface.userData.kind = "panel-surface";
    this.surface.userData.panelId = panel.id;
    this.add(this.surface);

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
    this.brushCursor.position.z = 0.025;
    this.brushCursor.renderOrder = 20;
    this.brushCursor.visible = false;
    this.add(this.brushCursor);

    this.modeIndicator = new THREE.Mesh(
      new THREE.PlaneGeometry(0.12, 0.036),
      new THREE.MeshBasicMaterial({
        map: makeLabelTexture("Fit", { width: 240, height: 72 }),
        transparent: true,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    this.modeIndicator.position.z = 0.02;
    this.modeIndicator.visible = false;
    this.add(this.modeIndicator);

    this.controls = new THREE.Group();
    this.controls.name = "controls";
    this.add(this.controls);
    this.#createControls();
    this.editorControls = new THREE.Group();
    this.editorControls.name = "mask-editor-controls";
    this.editorControls.visible = false;
    this.add(this.editorControls);
    this.#createEditorControls();
    this.applyState(panel);
  }

  #createControls() {
    for (const [index, [label, action]] of CONTROL_DEFINITIONS.entries()) {
      const button = makeButton(label, action, {
        width: CONTROL_BUTTON_WIDTH,
        height: CONTROL_BUTTON_HEIGHT,
      });
      button.position.set(
        ((index % 3) - 1) * (CONTROL_BUTTON_WIDTH + CONTROL_BUTTON_GAP),
        (1 - Math.floor(index / 3)) * (CONTROL_BUTTON_HEIGHT + 0.008),
        0.015,
      );
      button.userData.panelId = this.panel.id;
      button.userData.gestureTarget = false;
      this.controls.add(button);
    }
    this.tagMenu = new TagMenu({
      title: "MEDIA TAGS",
      prefix: "media",
      onAction: (_action, tagIds) => this.callbacks.onTagSelection?.(this.panel.id, tagIds),
    });
    this.tagMenu.position.set(0, -0.41, 0.04);
    this.add(this.tagMenu);
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
        width: 0.14,
        height: 0.044,
        textureWidth: 420,
      });
      button.position.set(
        (index - 1) * 0.155,
        -0.045,
        0.02,
      );
      button.userData.panelId = this.panel.id;
      button.userData.gestureTarget = false;
      this.editorControls.add(button);
    }
  }

  applyState(panel) {
    this.panel = panel;
    const minimized = Boolean(panel.minimized);
    const width =
      minimized ? 0.3 : panel.width ?? panel.dimensions?.width ?? panel.size?.width ?? 0.95;
    const height =
      minimized ? 0.18 : panel.height ?? panel.dimensions?.height ?? panel.size?.height ?? 0.58;
    this.frame.scale.set(width + 0.025, height + 0.025, 1);
    this.controls.visible = !minimized && Boolean(panel.focused ?? true);
    const controlScale = Math.min(1, Math.max(0.3, (width - 0.025) / CONTROL_ROW_WIDTH));
    this.controls.scale.setScalar(controlScale);
    this.controls.position.set(0, height / 2 + 0.07, 0);
    this.editorControls.scale.setScalar(Math.min(1, Math.max(0.35, (width - 0.02) / 0.78)));
    this.editorControls.position.set(0, -height / 2 + 0.09, 0.03);
    this.editorControls.visible = this.editorActive && !minimized;
    this.modeIndicator.position.set(width / 2 - 0.075, -height / 2 + 0.035, 0.02);

    const position = panel.position ?? panel.transform?.position;
    const rotation = panel.rotation ?? panel.transform?.rotation;
    if (position) {
      this.position.set(position.x ?? 0, position.y ?? 1.35, position.z ?? -1.5);
    }
    if (rotation) {
      this.rotation.set(rotation.x ?? 0, rotation.y ?? 0, rotation.z ?? 0);
    }
    this.userData.locked = Boolean(panel.locked);
    this.userData.minimized = minimized;
    this.userData.zoomMode = Boolean(panel.zoomMode ?? panel.contentZoomMode);
    const normalDimensions = panel.restoreDimensions ?? panel.dimensions ?? { width, height };
    const scaleLimits = minimized
      ? { min: 1, max: 1 }
      : {
        min: Math.max(0.2 / normalDimensions.width, 0.15 / normalDimensions.height),
        max: Math.min(5 / normalDimensions.width, 5 / normalDimensions.height),
      };
    this.userData.manipulation = {
      type: "panel",
      scalable: !minimized && !this.userData.locked && !this.userData.zoomMode,
      dimensions: { width, height },
      initialDimensions: {
        width: normalDimensions.width,
        height: normalDimensions.height,
      },
      scaleLimits,
    };

    this.#updateControlStates();

    this.#applyContentTransform(width, height);
  }

  #applyContentTransform(panelWidth, panelHeight) {
    const texture = this.surface.material.map;
    if (!texture) return;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    if (!this.mediaSize) {
      this.surface.scale.set(panelWidth, panelHeight, 1);
      this.surface.position.set(0, 0, 0);
      this.maskOverlay.scale.copy(this.surface.scale);
      this.maskOverlay.position.set(0, 0, 0.008);
      texture.repeat.set(1, 1);
      texture.offset.set(0, 0);
      this.contentUv = { repeat: { x: 1, y: 1 }, offset: { x: 0, y: 0 } };
      this.#syncMaskTransforms();
      return;
    }
    const zoom = this.panel.contentZoom ?? this.panel.content?.zoom ?? 1;
    const pan = this.panel.pan ?? this.panel.content?.pan ?? { x: 0, y: 0 };
    const layout = mediaDisplayLayout({
      mode: this.panel.displayMode,
      panelWidth,
      panelHeight,
      sourceWidth: this.mediaSize.width,
      sourceHeight: this.mediaSize.height,
      contentZoom: zoom,
      contentPan: pan,
    });
    this.surface.scale.set(layout.surface.width, layout.surface.height, 1);
    this.surface.position.set(layout.position.x, layout.position.y, 0);
    this.maskOverlay.scale.copy(this.surface.scale);
    this.maskOverlay.position.set(layout.position.x, layout.position.y, 0.008);
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
    this.controls.visible = focused && !this.panel.minimized && !this.editorActive;
    this.editorControls.visible = focused && !this.panel.minimized && this.editorActive;
    this.frame.material.color.set(focused ? 0x9be7b5 : 0x0a0f0f);
    this.#updateFrameVisibility();
  }

  async showMedia(item, url, options = {}) {
    this.#clearPendingImageTap();
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
    this.tagMenu.setDefinitions(definitions);
  }

  setMediaTagSelection(tagIds) {
    this.tagMenu.setSelected(tagIds);
  }

  toggleMediaTags(definitions, tagIds) {
    this.tagMenu.setDefinitions(definitions);
    this.tagMenu.setSelected(tagIds);
    return this.tagMenu.toggle();
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

  beginMaskEditor(maskCanvas, { brushSize, blur } = {}) {
        this.editorActive = true;
        const changedCanvas = this.maskCanvas !== maskCanvas;
        this.maskCanvas = maskCanvas;
        this.maskBlur = clampMaskBlur(blur);
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
        this.#updateEditorControls(brushSize, this.maskBlur);
        this.setFocused(true);
  }

  updateMaskEditor(maskCanvas, { brushSize, blur } = {}) {
        if (!this.editorActive) return;
        this.maskCanvas = maskCanvas;
        this.maskBlur = clampMaskBlur(blur);
        this.#updateEditorControls(brushSize, this.maskBlur);
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
        this.surface.userData.gestureTarget = undefined;
        this.frame.userData.gestureTarget = undefined;
        this.surface.userData.drawTarget = undefined;
        this.userData.maskEditing = false;
        this.maskOverlay.visible = false;
        this.#hideBrushCursor();
        this.editorControls.visible = false;
        this.controls.visible = !this.panel.minimized;
  }

  #updateControlStates() {
        for (const control of this.controls.children) {
          const action = control.userData.action;
          const inactive = (action === "toggle-mask" && !this.maskAvailable)
            || (action === "edit-erase-mask" && !this.mediaLoaded);
          const tagInactive = action === "toggle-media-tags" && !this.panel.media?.selectedId;
          const active =
            (action === "toggle-lock" && this.panel.locked) ||
            (action === "toggle-slideshow" && this.panel.slideshow?.playing) ||
            (action === "toggle-zoom" && (this.panel.zoomMode ?? this.panel.contentZoomMode)) ||
            (action === "toggle-mask" && this.panel.maskEnabled && this.maskAvailable);
          control.material.color.set((inactive || tagInactive) ? 0x5f6b67 : active ? 0xaaf1c3 : 0xffffff);
        }
  }

  #updateEditorControls(brushSize, blur) {
        this.editorBrushSize = clampBrushSize(brushSize);
        this.brushSlider.setValue(this.editorBrushSize);
        this.blurSlider.setValue(clampMaskBlur(blur));
        if (this.brushCursorUv) this.#showBrushCursor(this.brushCursorUv);
  }

  #showBrushCursor(uv) {
        if (!this.editorActive || !this.maskCanvas) return;
        this.brushCursorUv = { x: uv.x, y: uv.y };
        const minimum = Math.min(this.maskCanvas.width, this.maskCanvas.height);
        const radiusX = (this.editorBrushSize * minimum) / (2 * this.maskCanvas.width);
        const radiusY = (this.editorBrushSize * minimum) / (2 * this.maskCanvas.height);
        const repeatX = Math.max(Math.abs(this.contentUv.repeat.x), 1e-6);
        const repeatY = Math.max(Math.abs(this.contentUv.repeat.y), 1e-6);
        this.brushCursor.position.set(
          this.surface.position.x + (uv.x - 0.5) * this.surface.scale.x,
          this.surface.position.y + (uv.y - 0.5) * this.surface.scale.y,
          0.025,
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
    if (this.mediaType === "image") {
      this.#queueImageTap(uv);
      return;
    }
    this.#activateSingle(uv);
  }

  #activateSingle(uv) {
    if (uv.x <= 0.25) {
      this.callbacks.onAction?.(this.panel.id, "previous");
    } else if (uv.x >= 0.75) {
      this.callbacks.onAction?.(this.panel.id, "next");
    } else if (this.mediaTexture.video) {
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
        this.callbacks.onAction?.(this.panel.id, "cycle-display-mode");
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
    if (triggerSingle) this.#activateSingle(pending.uv);
  }

  showDisplayModeIndicator(mode) {
    const resolved = normalizeDisplayMode(mode);
    const label = resolved === "actual" ? "1:1" : resolved[0].toUpperCase() + resolved.slice(1);
    this.#showModeIndicator(label);
  }

  showAspectRatioIndicator(mode) {
    const resolved = normalizeAspectRatioMode(mode);
    const label = resolved === ASPECT_RATIO_MODES.NATIVE ? "Native" : resolved;
    this.#showModeIndicator(label);
  }

  #showModeIndicator(label) {
    const previous = this.modeIndicator.material.map;
    this.modeIndicator.material.map = makeLabelTexture(label, { width: 240, height: 72 });
    this.modeIndicator.material.needsUpdate = true;
    previous?.dispose();
    this.modeIndicator.visible = true;
    clearTimeout(this.modeIndicatorTimer);
    this.modeIndicatorTimer = setTimeout(() => {
      this.modeIndicator.visible = false;
      this.modeIndicatorTimer = null;
    }, 1200);
  }

  dispose() {
    this.#clearPendingImageTap();
    clearTimeout(this.modeIndicatorTimer);
    if (this.editorFrame != null) cancelAnimationFrame(this.editorFrame);
    this.#clearMaskTextures();
    this.mediaTexture.dispose();
    disposeObject(this);
  }
}
