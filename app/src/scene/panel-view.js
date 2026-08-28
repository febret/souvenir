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
import { createDisplacedPlaneGeometry, resolveFadeDepthRange } from "./depth-surface.js";
import { ADM_SLIDER_ROW_STEP } from "./panel-options/constants.js";

const DOUBLE_TAP_WINDOW_MS = 325;
const DOUBLE_TAP_MAX_UV_DISTANCE = 0.15;

const CONTROL_DEFINITIONS = [
  ["🎞️", "browse", "700 148px system-ui, sans-serif"],
  ["◀️", "previous", "700 148px system-ui, sans-serif"],
  ["⏯️", "toggle-slideshow", "700 126px system-ui, sans-serif"],
  ["▶️", "next", "700 148px system-ui, sans-serif"],
  ["🔒", "toggle-lock", "700 136px system-ui, sans-serif"],
  ["➖", "toggle-minimize", "700 142px system-ui, sans-serif"],
  ["⚙️", "toggle-options", "700 148px system-ui, sans-serif"],
];
const CONTROL_BUTTON_SIZE = 0.08;
const CONTROL_BUTTON_GAP = 0.018;
const CONTROL_ROW_WIDTH =
  CONTROL_DEFINITIONS.length * CONTROL_BUTTON_SIZE
  + (CONTROL_DEFINITIONS.length - 1) * CONTROL_BUTTON_GAP;
const PANEL_UI_FRONT_BASE_Z = 0.02;
const PANEL_UI_DEPTH_CLEARANCE_Z = 0.012;
const PANEL_NUMBER_BADGE_BASE_Z = 0.02;
const PANEL_CONTROLS_BASE_Z = 0;
const PANEL_EDITOR_CONTROLS_BASE_Z = 0.03;
const PANEL_OPTIONS_BASE_Z = 0.03;
const PANEL_ADM_PROMPT_BASE_Z = 0.04;
const PANEL_BRUSH_CURSOR_BASE_Z = 0.025;
const MAX_OPTIONS_OFFSET_X = 0.9;
const MAX_OPTIONS_OFFSET_Y = 0.65;
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

const ADM_FOCUS_POSITIONS = Object.freeze(["middle", "back", "front"]);
const ADM_FOCUS_STRENGTHS = Object.freeze(["middle", "weak", "strong"]);

const LIGHT_DIRECTIONS_SET = new Set(["front", "top", "top-left", "top-right", "left", "right"]);
const LIGHT_COLORS_SET = new Set(["white", "warm", "cool", "rose", "mint", "gold"]);

const LIGHT_DIRECTION_VECTORS = Object.freeze({
  front:      [0,    0,   1],
  top:        [0,    1,   0.5],
  "top-left": [-1,   1,   0.5],
  "top-right":[1,    1,   0.5],
  left:       [-1,   0,   0.5],
  right:      [1,    0,   0.5],
});

const LIGHT_COLOR_HEX = Object.freeze({
  white: 0xffffff,
  warm:  0xffd6a0,
  cool:  0xb0d4ff,
  rose:  0xffb0c8,
  mint:  0xa8f0d8,
  gold:  0xffe080,
});

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function normalizeFocusPosition(value) {
  return ADM_FOCUS_POSITIONS.includes(value) ? value : "middle";
}

function normalizeFocusStrength(value) {
  return ADM_FOCUS_STRENGTHS.includes(value) ? value : "middle";
}

const PANEL_SURFACE_VERTEX_SHADER = `
  varying vec2 vUv;
  varying vec3 vNormalView;

  void main() {
    vUv = uv;
    vNormalView = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PANEL_SURFACE_FRAGMENT_SHADER = `
  uniform sampler2D uMap;
  uniform sampler2D uDepthMap;
  uniform sampler2D uMaskMap;
  uniform vec2 uUvRepeat;
  uniform vec2 uUvOffset;
  uniform vec2 uTexelSize;
  uniform float uUseDepth;
  uniform float uSoftEnabled;
  uniform float uSoftBlurPx;
  uniform float uFocusEnabled;
  uniform float uFocalDepth;
  uniform float uFocusBlurScale;
  uniform float uFadeEnabled;
  uniform float uFadeStartDepth;
  uniform float uFadeEndDepth;
  uniform float uMaskEnabled;
  uniform float uAlphaTest;
  uniform float uLightFxEnabled;
  uniform vec3 uLightDirection;
  uniform vec3 uLightColor;
  uniform vec3 uAmbientColor;
  uniform float uAmbientIntensity;
  uniform float uBaseOpacity;
  varying vec2 vUv;
  varying vec3 vNormalView;

  vec4 sampleColor(vec2 uv) {
    return texture2D(uMap, uv);
  }

  void main() {
    vec2 mappedUv = vUv * uUvRepeat + uUvOffset;
    vec4 center = sampleColor(mappedUv);

    float depthValue = 0.5;
    if (uUseDepth > 0.5) {
      depthValue = texture2D(uDepthMap, mappedUv).r;
    }

    float softPx = uSoftEnabled > 0.5 ? clamp(uSoftBlurPx, 0.0, 24.0) : 0.0;
    float focusPx = 0.0;
    if (uUseDepth > 0.5 && uFocusEnabled > 0.5) {
      focusPx = abs(depthValue - uFocalDepth) * uFocusBlurScale * 28.0;
    }
    float radiusPx = clamp(softPx * 0.22 + focusPx, 0.0, 24.0);
    vec2 radiusUv = uTexelSize * radiusPx;

    vec4 blurred =
      sampleColor(mappedUv + vec2(-1.0, 0.0) * radiusUv * 0.65) * 0.12 +
      sampleColor(mappedUv + vec2( 1.0, 0.0) * radiusUv * 0.65) * 0.12 +
      sampleColor(mappedUv + vec2(0.0, -1.0) * radiusUv * 0.65) * 0.12 +
      sampleColor(mappedUv + vec2(0.0,  1.0) * radiusUv * 0.65) * 0.12 +
      sampleColor(mappedUv + vec2(-0.707, -0.707) * radiusUv) * 0.10 +
      sampleColor(mappedUv + vec2( 0.707, -0.707) * radiusUv) * 0.10 +
      sampleColor(mappedUv + vec2(-0.707,  0.707) * radiusUv) * 0.10 +
      sampleColor(mappedUv + vec2( 0.707,  0.707) * radiusUv) * 0.10 +
      center * 0.12;

    float blurMix = smoothstep(0.0, 1.0, radiusPx / 12.0);
    vec4 color = mix(center, blurred, blurMix);

    if (uFadeEnabled > 0.5 && uUseDepth > 0.5) {
      float fadeSpan = max(0.0001, uFadeEndDepth - uFadeStartDepth);
      float fadeProgress = clamp((depthValue - uFadeStartDepth) / fadeSpan, 0.0, 1.0);
      float fadeAlpha = 1.0 - fadeProgress;
      color.a *= fadeAlpha;
    }

    if (uMaskEnabled > 0.5) {
      color.a *= texture2D(uMaskMap, mappedUv).r;
    }

    float ndl = max(0.0, dot(normalize(vNormalView), normalize(uLightDirection)));
    vec3 lit = color.rgb;
    if (uLightFxEnabled > 0.5) {
      vec3 ambient = uAmbientColor * uAmbientIntensity;
      vec3 directional = uLightColor * (0.25 + ndl * 0.75);
      lit = color.rgb * (ambient + directional);
    }

    float alpha = color.a * uBaseOpacity;
    if (alpha <= uAlphaTest) discard;
    gl_FragColor = vec4(lit, alpha);
  }
`;

function focusDepthForPosition(position) {
  if (position === "back") return 0.78;
  if (position === "front") return 0.22;
  return 0.5;
}

function focusStrengthScale(strength) {
  if (strength === "weak") return 0.7;
  if (strength === "strong") return 1.6;
  return 1;
}

function createDepthCanvasTexture(canvas) {
  if (!canvas) return null;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function createSurfaceMaterial(texture) {
  const fallback = texture ?? makeBlankTexture();
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      uMap: { value: fallback },
      uDepthMap: { value: fallback },
      uMaskMap: { value: fallback },
      uUvRepeat: { value: new THREE.Vector2(1, 1) },
      uUvOffset: { value: new THREE.Vector2(0, 0) },
      uTexelSize: { value: new THREE.Vector2(1 / Math.max(1, fallback.image?.width ?? 1), 1 / Math.max(1, fallback.image?.height ?? 1)) },
      uUseDepth: { value: 0 },
      uSoftEnabled: { value: 0 },
      uSoftBlurPx: { value: 0 },
      uFocusEnabled: { value: 0 },
      uFocalDepth: { value: 0.5 },
      uFocusBlurScale: { value: 1 },
      uFadeEnabled: { value: 0 },
      uFadeStartDepth: { value: 0.5 },
      uFadeEndDepth: { value: 1 },
      uMaskEnabled: { value: 0 },
      uAlphaTest: { value: 0 },
      uLightFxEnabled: { value: 0 },
      uLightDirection: { value: new THREE.Vector3(0, 0, 1) },
      uLightColor: { value: new THREE.Color(0xffffff) },
      uAmbientColor: { value: new THREE.Color(0xffffff) },
      uAmbientIntensity: { value: 0.5 },
      uBaseOpacity: { value: 1 },
    },
    vertexShader: PANEL_SURFACE_VERTEX_SHADER,
    fragmentShader: PANEL_SURFACE_FRAGMENT_SHADER,
  });
  material.map = fallback;
  material.alphaMap = null;
  material.alphaTest = 0;
  return material;
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
    this.depthMapTexture = null;
    this.editorActive = false;
    this.editorBrushSize = 0.05;
    this.maskEraseMode = true;
    this.autoMaskBusy = false;
    this.brushCursorUv = null;
    this.contentUv = { repeat: { x: 1, y: 1 }, offset: { x: 0, y: 0 } };
    this.depthMapCanvas = null;
    this.minimumDepthSample = 0;
    this.maximumDepthSample = 1;
    this.maximumSurfaceDepth = 0;
    this.admEnabled = false;
    this.admBusy = false;
    this.depthIntensity = 0.35;
    this.softDepthEnabled = false;
    this.softDepthBlur = 12;
    this.fadeDepthEnabled = false;
    this.fadeDepthStart = 0.5;
    this.focusBlurEnabled = false;
    this.focusPosition = "middle";
    this.focusStrength = "middle";
    this.lightFxEnabled = false;
    this.lightDirection = "front";
    this.lightColor = "white";
    this.ambientColor = "white";
    this.ambientIntensity = 0.5;
    this.surfaceFlatGeometry = null;
    this.admPromptVisible = false;
    this.sceneTransitionActive = false;
    this.sceneTransitionInteractiveStates = new Map();
    this.optionsOpen = false;
    this.uiVisible = true;
    this.zenMode = false;
    this.mediaTagIds = [];
    this.tagDefinitions = [];
    this.tagListExpanded = true;
    this.saveMode = "scale";
    this.numberBadgeSignature = "";
    this.contentLayoutSignature = "";
    this.depthGeometryState = null;
    this.optionsOffset = { x: 0, y: 0 };
    this.activeViewCamera = null;
    this.scratchUiWorldPosition = new THREE.Vector3();
    this.scratchUiParentQuaternion = new THREE.Quaternion();
    this.scratchUiWorldQuaternion = new THREE.Quaternion();
    this.scratchUiLocalQuaternion = new THREE.Quaternion();
    this.scratchUiFacingCorrection = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI,
    );
    this.scratchUiTarget = new THREE.Vector3();
    this.scratchUiMatrix = new THREE.Matrix4();
    this.scratchUiUp = new THREE.Vector3(0, 1, 0);
    this.scratchUiScale = new THREE.Vector3();
    this.uiBillboards = [];
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
    this.uiRoot = new THREE.Group();
    this.add(this.uiRoot);
    this.uiRoot.add(this.numberBadge);

    this.surface = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      createSurfaceMaterial(makeBlankTexture()),
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
    this.uiRoot.add(this.controls);
    this.#createControls();
    this.optionsPanel = new PanelOptionsView(this.panel.id, {
      onDrag: (gesture) => this.#handleOptionsDrag(gesture),
    });
    this.uiRoot.add(this.optionsPanel);
    this.#createAdmControls();
    this.editorControls = new THREE.Group();
    this.editorControls.name = "mask-editor-controls";
    this.editorControls.visible = false;
    this.uiRoot.add(this.editorControls);
    this.#createEditorControls();
    this.#createAdmPrompt();
    this.uiBillboards = [
      this.numberBadge,
      this.controls,
      this.optionsPanel,
      this.editorControls,
      this.admPrompt,
    ];
    this.overlayScene = null;
    this.overlayAnchors = new Map();
    this.overlayGroups = [this.controls, this.optionsPanel, this.editorControls, this.admPrompt];
    this.applyState(panel);
  }

  /**
   * Moves popup/control groups into the given overlay scene so they are
   * rendered as a screen-space overlay (always in front) in Desktop Preview.
   * Anchor Object3Ds remain in uiRoot to track each group's intended world
   * transform; tick() copies those transforms to the overlay scene each frame.
   */
  setOverlayScene(scene) {
    if (this.overlayScene === scene) return;
    this.clearOverlayScene();
    this.overlayScene = scene;
    for (const group of this.overlayGroups) {
      const anchor = new THREE.Object3D();
      anchor.position.copy(group.position);
      anchor.quaternion.copy(group.quaternion);
      anchor.scale.copy(group.scale);
      this.uiRoot.add(anchor);
      this.overlayAnchors.set(group, anchor);
      this.uiRoot.remove(group);
      scene.add(group);
    }
    // Remove overlayed groups from billboard list; they are handled separately.
    this.uiBillboards = this.uiBillboards.filter((b) => !this.overlayGroups.includes(b));
  }

  /** Returns overlay groups back to uiRoot and removes anchors. */
  clearOverlayScene() {
    if (!this.overlayScene) return;
    for (const group of this.overlayGroups) {
      const anchor = this.overlayAnchors.get(group);
      if (anchor) {
        this.uiRoot.remove(anchor);
        this.overlayAnchors.delete(group);
      }
      this.overlayScene.remove(group);
      this.uiRoot.add(group);
    }
    this.overlayScene = null;
    this.uiBillboards = [
      this.numberBadge,
      this.controls,
      this.optionsPanel,
      this.editorControls,
      this.admPrompt,
    ];
  }

  #createControls() {
    for (const [index, [label, action, font]] of CONTROL_DEFINITIONS.entries()) {
      const button = makeButton(label, action, {
        width: CONTROL_BUTTON_SIZE,
        height: CONTROL_BUTTON_SIZE,
        textureWidth: 240,
        textureHeight: 240,
        shape: "circle",
        font,
        padding: 0,
      });
      button.position.set(
        (index - (CONTROL_DEFINITIONS.length - 1) / 2) * (CONTROL_BUTTON_SIZE + CONTROL_BUTTON_GAP),
        0,
        0.015,
      );
      button.userData.panelId = this.panel.id;
      button.userData.gestureTarget = false;
      this.controls.add(button);
    }
  }

  #refreshOptionsPanel(width = this.panel?.dimensions?.width ?? 1.2, height = this.panel?.dimensions?.height ?? 0.8) {
    const rebuilt = this.optionsPanel.update({
      saveMode: this.saveMode,
      tagDefinitions: this.tagDefinitions,
      mediaTagIds: this.mediaTagIds,
      tagListExpanded: this.tagListExpanded,
      depthOffset: PANEL_OPTIONS_BASE_Z + this.#uiDepthOffset(),
      admSettings: {        softDepthEnabled: this.softDepthEnabled,
        fadeDepthEnabled: this.fadeDepthEnabled,
        focusBlurEnabled: this.focusBlurEnabled,
        focusPosition: this.focusPosition,
        focusStrength: this.focusStrength,
        lightFxEnabled: this.lightFxEnabled,
        lightDirection: this.lightDirection,
        lightColor: this.lightColor,
        ambientColor: this.ambientColor,
        ambientIntensity: this.ambientIntensity,
      },
    });
    this.#layoutOptionsPanel(width, height);
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
    this.admControls = new THREE.Group();
    this.depthSlider = new SpatialSlider({
      title: "Depth",
      action: "adm-depth-slider",
      min: 0,
      max: 3,
      step: 0.05,
      value: this.depthIntensity,
      width: 0.7,
      formatValue: (value) => `${value.toFixed(2)}x`,
      onChange: (value) => this.callbacks.onAdmSetting?.(
        this.panel.id,
        "depthIntensity",
        value,
      ),
    });
    this.depthSlider.track.userData.panelId = this.panel.id;
    this.depthSlider.position.set(0, 0, 0.004);
    this.admControls.add(this.depthSlider);

    this.softDepthSlider = new SpatialSlider({
      title: "Soft blur",
      action: "adm-soft-depth-slider",
      min: 2,
      max: 64,
      step: 2,
      value: this.softDepthBlur,
      width: 0.56,
      formatValue: (value) => `${Math.round(value)}px`,
      onChange: (value) => this.callbacks.onAdmSetting?.(
        this.panel.id,
        "softDepthBlur",
        value,
      ),
    });
    this.softDepthSlider.track.userData.panelId = this.panel.id;
    this.softDepthSlider.position.set(0, -ADM_SLIDER_ROW_STEP, 0.004);
    this.admControls.add(this.softDepthSlider);

    this.fadeDepthSlider = new SpatialSlider({
      title: "Fade start",
      action: "adm-fade-depth-slider",
      min: 0,
      max: 1,
      step: 0.05,
      value: this.fadeDepthStart,
      width: 0.56,
      formatValue: (value) => value.toFixed(2),
      onChange: (value) => this.callbacks.onAdmSetting?.(
        this.panel.id,
        "fadeDepthStart",
        value,
      ),
    });
    this.fadeDepthSlider.track.userData.panelId = this.panel.id;
    this.fadeDepthSlider.position.set(0, -ADM_SLIDER_ROW_STEP * 2, 0.004);
    this.admControls.add(this.fadeDepthSlider);

    this.focusPositionSlider = new SpatialSlider({
      title: "Focus pos",
      action: "adm-focus-position-slider",
      min: 0,
      max: 2,
      step: 1,
      value: this.focusPosition === "back" ? 0 : this.focusPosition === "front" ? 2 : 1,
      width: 0.56,
      formatValue: (value) => value === 0 ? "back" : value === 2 ? "front" : "middle",
      onChange: (value) => this.callbacks.onAdmSetting?.(
        this.panel.id,
        "focusPosition",
        value === 0 ? "back" : value === 2 ? "front" : "middle",
      ),
    });
    this.focusPositionSlider.track.userData.panelId = this.panel.id;
    this.focusPositionSlider.position.set(0, -ADM_SLIDER_ROW_STEP * 3, 0.004);
    this.admControls.add(this.focusPositionSlider);

    this.focusStrengthSlider = new SpatialSlider({
      title: "Focus strength",
      action: "adm-focus-strength-slider",
      min: 0,
      max: 2,
      step: 1,
      value: this.focusStrength === "weak" ? 0 : this.focusStrength === "strong" ? 2 : 1,
      width: 0.56,
      formatValue: (value) => value === 0 ? "weak" : value === 2 ? "strong" : "middle",
      onChange: (value) => this.callbacks.onAdmSetting?.(
        this.panel.id,
        "focusStrength",
        value === 0 ? "weak" : value === 2 ? "strong" : "middle",
      ),
    });
    this.focusStrengthSlider.track.userData.panelId = this.panel.id;
    this.focusStrengthSlider.position.set(0, -ADM_SLIDER_ROW_STEP * 4, 0.004);
    this.admControls.add(this.focusStrengthSlider);
    this.optionsPanel.setDepthControl(this.admControls);
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
    this.uiRoot.add(this.admPrompt);
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
    const controlScale = Math.min(1, Math.max(0.42, (width - 0.025) / CONTROL_ROW_WIDTH));
    this.controls.scale.setScalar(controlScale);
    this.controls.position.set(0, height / 2 + 0.09, PANEL_CONTROLS_BASE_Z);
    this.#syncAnchorXYScale(this.controls);
    this.depthSlider.setValue(this.depthIntensity);
    this.editorControls.scale.setScalar(Math.min(1, Math.max(0.35, (width - 0.02) / 0.78)));
    this.editorControls.position.set(0, -height / 2 + 0.13, PANEL_EDITOR_CONTROLS_BASE_Z);
    this.#syncAnchorXYScale(this.editorControls);
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
    this.depthSlider.visible = this.optionsPanel.visible;

    this.#applyContentTransform(width, height);
    this.#applyUiDepthOffset();
    this.#alignUiToCamera(this.activeViewCamera);
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
      this.#applyDepthEffects();
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
    this.#applyDepthEffects();
    if (this.brushCursorUv) this.#showBrushCursor(this.brushCursorUv);
  }

  setFocused(focused) {
    this.controls.visible = this.uiVisible && focused && !this.panel.minimized && !this.editorActive && !this.zenMode;
    this.editorControls.visible = this.uiVisible && focused && !this.panel.minimized && this.editorActive;
    this.depthSlider.visible = this.uiVisible && focused && !this.panel.minimized
      && this.optionsOpen && !this.zenMode;
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
      if (this.surface.material.uniforms?.uMap) {
        this.surface.material.uniforms.uMap.value = result.texture;
      }
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
      this.#applyDepthEffects();
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

  toggleTagList() {
    this.tagListExpanded = !this.tagListExpanded;
    this.#refreshOptionsPanel();
    this.#updateControlStates();
    return this.tagListExpanded;
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
        this.#applyDepthEffects();
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
          if (!control.material?.color) continue;
          const action = control.userData.action;
          const inactive = this.admPromptVisible;
          const tagInactive = false;
          const active =
            (action === "toggle-lock" && this.panel.locked) ||
            (action === "toggle-options" && this.optionsOpen) ||
            (action === "toggle-slideshow" && this.panel.slideshow?.playing);
          control.material.color.set((inactive || tagInactive) ? 0x5f6b67 : active ? 0xaaf1c3 : 0xffffff);
        }
        this.optionsPanel.updateControlStates({
          maskAvailable: this.maskAvailable,
          mediaLoaded: this.mediaLoaded,
          mediaType: this.mediaType,
          maskEnabled: this.panel.maskEnabled,
          admEnabled: this.admEnabled,
          admPromptVisible: this.admPromptVisible,
          softDepthEnabled: this.softDepthEnabled,
          fadeDepthEnabled: this.fadeDepthEnabled,
          focusBlurEnabled: this.focusBlurEnabled,
          lightFxEnabled: this.lightFxEnabled,
          lightDirection: this.lightDirection,
          lightColor: this.lightColor,
          ambientColor: this.ambientColor,
          ambientIntensity: this.ambientIntensity,
          depthAvailable: Boolean(this.depthMapCanvas),
        });
        const sliderInteractive = this.admEnabled
          && this.mediaType === "image"
          && this.mediaLoaded
          && !this.admBusy
          && !this.admPromptVisible;
        for (const slider of [
          this.depthSlider,
          this.softDepthSlider,
          this.fadeDepthSlider,
          this.focusPositionSlider,
          this.focusStrengthSlider,
        ]) {
          if (!slider?.track) continue;
          slider.track.userData.interactive = sliderInteractive;
          slider.track.material.color.set(sliderInteractive ? 0xffffff : 0x7f8b88);
        }
  }

  setAdmState({
    enabled,
    intensity,
    softDepthEnabled = this.softDepthEnabled,
    softDepthBlur = this.softDepthBlur,
    fadeDepthEnabled = this.fadeDepthEnabled,
    fadeDepthStart = this.fadeDepthStart,
    focusBlurEnabled = this.focusBlurEnabled,
    focusPosition = this.focusPosition,
    focusStrength = this.focusStrength,
    lightFxEnabled = this.lightFxEnabled,
    lightDirection = this.lightDirection,
    lightColor = this.lightColor,
    ambientColor = this.ambientColor,
    ambientIntensity = this.ambientIntensity,
    busy = this.admBusy,
  } = {}) {
    this.admEnabled = Boolean(enabled);
    this.depthIntensity = Math.max(0, Math.min(3, Number(intensity) || 0.35));
    this.softDepthEnabled = Boolean(softDepthEnabled);
    this.softDepthBlur = clampNumber(softDepthBlur, 2, 64);
    this.fadeDepthEnabled = Boolean(fadeDepthEnabled);
    this.fadeDepthStart = clampNumber(fadeDepthStart, 0, 1);
    this.focusBlurEnabled = Boolean(focusBlurEnabled);
    this.focusPosition = normalizeFocusPosition(focusPosition);
    this.focusStrength = normalizeFocusStrength(focusStrength);
    this.lightFxEnabled = Boolean(lightFxEnabled);
    this.lightDirection = LIGHT_DIRECTIONS_SET.has(lightDirection) ? lightDirection : "front";
    this.lightColor = LIGHT_COLORS_SET.has(lightColor) ? lightColor : "white";
    this.ambientColor = LIGHT_COLORS_SET.has(ambientColor) ? ambientColor : "white";
    this.ambientIntensity = clampNumber(ambientIntensity, 0, 1);
    this.admBusy = Boolean(busy);
    this.depthSlider.setValue(this.depthIntensity);
    this.softDepthSlider?.setValue(this.softDepthBlur);
    this.fadeDepthSlider?.setValue(this.fadeDepthStart);
    this.focusPositionSlider?.setValue(this.focusPosition === "back" ? 0 : this.focusPosition === "front" ? 2 : 1);
    this.focusStrengthSlider?.setValue(this.focusStrength === "weak" ? 0 : this.focusStrength === "strong" ? 2 : 1);
    this.#applyDepthGeometry();
    this.#applyDepthEffects();
    this.#applyLighting();
    this.#refreshOptionsPanel();
    this.#updateControlStates();
  }

  setDepthMap(depthCanvas) {
    this.depthMapCanvas = depthCanvas ?? null;
    this.depthMapTexture?.dispose();
    this.depthMapTexture = createDepthCanvasTexture(this.depthMapCanvas);
    this.#applyDepthGeometry();
    this.#applyDepthEffects();
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
      this.minimumDepthSample = 0;
      this.maximumDepthSample = 1;
      this.maximumSurfaceDepth = 0;
      if (this.surface.geometry !== this.surfaceFlatGeometry) {
        this.surface.geometry.dispose();
        this.surface.geometry = this.surfaceFlatGeometry;
      }
      this.#applyUiDepthOffset();
      this.#applyDepthEffects();
      return;
    }
    if (this.surface.geometry !== this.surfaceFlatGeometry) {
      this.surface.geometry.dispose();
    }
    const {
      geometry,
      minimumSampleDepth,
      maximumSampleDepth,
      maximumDepth,
    } = createDisplacedPlaneGeometry(
      this.depthMapCanvas,
      this.depthIntensity,
      this.depthMapCanvas?.userData?.gridSegments,
    );
    this.surface.geometry = geometry;
    this.minimumDepthSample = minimumSampleDepth;
    this.maximumDepthSample = maximumSampleDepth;
    this.maximumSurfaceDepth = maximumDepth;
    this.#applyUiDepthOffset();
    this.#applyDepthEffects();
  }

  #applyDepthEffects() {
    const material = this.surface?.material;
    if (!material?.uniforms) return;
    const sourceTexture = material.map;
    if (!sourceTexture) return;

    const textureWidth = Math.max(1, sourceTexture.image?.videoWidth ?? sourceTexture.image?.width ?? 1);
    const textureHeight = Math.max(1, sourceTexture.image?.videoHeight ?? sourceTexture.image?.height ?? 1);
    material.uniforms.uMap.value = sourceTexture;
    material.uniforms.uDepthMap.value = this.depthMapTexture ?? sourceTexture;
    material.uniforms.uMaskMap.value = this.alphaMapTexture ?? sourceTexture;
    material.uniforms.uUvRepeat.value.set(this.contentUv.repeat.x, this.contentUv.repeat.y);
    material.uniforms.uUvOffset.value.set(this.contentUv.offset.x, this.contentUv.offset.y);
    material.uniforms.uTexelSize.value.set(1 / textureWidth, 1 / textureHeight);
    const useDepth = this.admEnabled && this.mediaType === "image" && this.depthMapTexture;
    material.uniforms.uUseDepth.value = useDepth ? 1 : 0;
    material.uniforms.uSoftEnabled.value = this.softDepthEnabled ? 1 : 0;
    material.uniforms.uSoftBlurPx.value = this.softDepthBlur;
    material.uniforms.uFocusEnabled.value = this.focusBlurEnabled ? 1 : 0;
    material.uniforms.uFadeEnabled.value = this.fadeDepthEnabled ? 1 : 0;
    const { startDepth, endDepth } = resolveFadeDepthRange(
      this.fadeDepthStart,
      useDepth ? this.minimumDepthSample : 0,
      useDepth ? this.maximumDepthSample : 1,
    );
    material.uniforms.uFadeStartDepth.value = startDepth;
    material.uniforms.uFadeEndDepth.value = endDepth;
    material.uniforms.uMaskEnabled.value = this.alphaMapTexture ? 1 : 0;
    material.uniforms.uAlphaTest.value = material.alphaTest ?? 0;
    material.uniforms.uBaseOpacity.value = material.opacity ?? 1;

    const baseFocalDepth = focusDepthForPosition(this.focusPosition);
    const cameraDistance = this.activeViewCamera ? this.position.distanceTo(this.activeViewCamera.position) : 1;
    const wobbleScale = Math.min(0.03, 0.004 + cameraDistance * 0.0035);
    const wobble = Math.sin((performance.now() || 0) * 0.001 + this.panel.id.length * 0.31) * wobbleScale;
    material.uniforms.uFocalDepth.value = clampNumber(baseFocalDepth + wobble, 0, 1);
    material.uniforms.uFocusBlurScale.value = focusStrengthScale(this.focusStrength);
  }

  #uiDepthOffset() {
    const maximumSurfaceDepth = Math.max(0, Number(this.maximumSurfaceDepth) || 0);
    return Math.max(0, maximumSurfaceDepth + PANEL_UI_DEPTH_CLEARANCE_Z - PANEL_UI_FRONT_BASE_Z);
  }

  #applyLighting() {
    const material = this.surface?.material;
    if (!material?.uniforms) return;
    const dirVec = LIGHT_DIRECTION_VECTORS[this.lightDirection] ?? LIGHT_DIRECTION_VECTORS.front;
    material.uniforms.uLightFxEnabled.value = this.admEnabled && this.mediaType === "image" && this.lightFxEnabled ? 1 : 0;
    material.uniforms.uLightDirection.value.set(dirVec[0], dirVec[1], dirVec[2]).normalize();
    material.uniforms.uLightColor.value.setHex(LIGHT_COLOR_HEX[this.lightColor] ?? 0xffffff);
    material.uniforms.uAmbientColor.value.setHex(LIGHT_COLOR_HEX[this.ambientColor] ?? 0xffffff);
    material.uniforms.uAmbientIntensity.value = this.ambientIntensity;
  }

  #applyUiDepthOffset() {
    const offset = this.#uiDepthOffset();
    if (this.numberBadge) this.numberBadge.position.z = PANEL_NUMBER_BADGE_BASE_Z + offset;
    this.#setOverlayGroupZ(this.controls, PANEL_CONTROLS_BASE_Z + offset);
    this.#setOverlayGroupZ(this.editorControls, PANEL_EDITOR_CONTROLS_BASE_Z + offset);
    this.#setOverlayGroupZ(this.optionsPanel, PANEL_OPTIONS_BASE_Z + offset);
    this.#setOverlayGroupZ(this.admPrompt, PANEL_ADM_PROMPT_BASE_Z + offset);
    if (this.brushCursor) this.brushCursor.position.z = PANEL_BRUSH_CURSOR_BASE_Z + offset;
  }

  /** Sets position.z on the group and, when in overlay mode, mirrors it to the anchor. */
  #setOverlayGroupZ(group, z) {
    if (!group) return;
    group.position.z = z;
    const anchor = this.overlayAnchors.get(group);
    if (anchor) anchor.position.z = z;
  }

  #layoutOptionsPanel(width = this.panel?.dimensions?.width ?? 1.2, height = this.panel?.dimensions?.height ?? 0.8) {
    const defaultX = width / 2 + this.optionsPanel.layout.width / 2 + 0.09;
    const defaultY = height / 2 - this.optionsPanel.layout.height / 2 + 0.04;
    const clampX = width / 2 + MAX_OPTIONS_OFFSET_X;
    const clampY = height / 2 + MAX_OPTIONS_OFFSET_Y;
    this.optionsOffset.x = Math.max(-clampX, Math.min(clampX, this.optionsOffset.x));
    this.optionsOffset.y = Math.max(-clampY, Math.min(clampY, this.optionsOffset.y));
    this.optionsPanel.position.x = defaultX + this.optionsOffset.x;
    this.optionsPanel.position.y = defaultY + this.optionsOffset.y;
    const optionsAnchor = this.overlayAnchors.get(this.optionsPanel);
    if (optionsAnchor) {
      optionsAnchor.position.copy(this.optionsPanel.position);
    }
  }

  #handleOptionsDrag(gesture) {
    if (gesture?.hands !== 1 || !gesture?.translation) return;
    this.optionsOffset.x += Number(gesture.translation.x) || 0;
    this.optionsOffset.y += Number(gesture.translation.y) || 0;
    const width = this.panel.minimized
      ? 0.3 : this.panel.width ?? this.panel.dimensions?.width ?? this.panel.size?.width ?? 0.95;
    const height = this.panel.minimized
      ? 0.18 : this.panel.height ?? this.panel.dimensions?.height ?? this.panel.size?.height ?? 0.58;
    this.#layoutOptionsPanel(width, height);
  }

  /** Copies current group local transforms to their overlay anchors after applyState updates them. */
  #syncAnchorsFromGroups() {
    if (!this.overlayScene) return;
    for (const group of this.overlayGroups) {
      const anchor = this.overlayAnchors.get(group);
      if (!anchor) continue;
      anchor.position.copy(group.position);
      anchor.scale.copy(group.scale);
    }
  }

  /** Mirrors x/y position and scale from a group to its overlay anchor. */
  #syncAnchorXYScale(group) {
    if (!group) return;
    const anchor = this.overlayAnchors.get(group);
    if (!anchor) return;
    anchor.position.x = group.position.x;
    anchor.position.y = group.position.y;
    anchor.scale.copy(group.scale);
  }

  /**
   * Copies the world transform of each anchor (which tracks the group's
   * intended in-scene position) to the corresponding overlay scene group,
   * then applies camera-facing (billboard) rotation so overlay groups always
   * face the viewer.
   */
  #syncOverlayGroups(camera) {
    if (!camera) return;
    for (const group of this.overlayGroups) {
      const anchor = this.overlayAnchors.get(group);
      if (!anchor) continue;
      anchor.updateWorldMatrix(true, false);
      anchor.getWorldPosition(this.scratchUiWorldPosition);
      anchor.getWorldScale(this.scratchUiScale);
      group.position.copy(this.scratchUiWorldPosition);
      group.scale.copy(this.scratchUiScale);
      // Billboard: face toward camera (yaw only, matching #alignUiToCamera).
      this.scratchUiTarget.set(camera.position.x, this.scratchUiWorldPosition.y, camera.position.z);
      if (this.scratchUiTarget.distanceToSquared(this.scratchUiWorldPosition) > 1e-9) {
        this.scratchUiMatrix.lookAt(
          this.scratchUiWorldPosition,
          this.scratchUiTarget,
          this.scratchUiUp,
        );
        this.scratchUiWorldQuaternion.setFromRotationMatrix(this.scratchUiMatrix);
        group.quaternion.copy(this.scratchUiWorldQuaternion).multiply(this.scratchUiFacingCorrection);
      }
    }
  }

  #alignUiToCamera(camera) {
    if (!camera) return;
    this.activeViewCamera = camera;
    for (const element of this.uiBillboards) {
      if (!element?.parent) continue;
      element.getWorldPosition(this.scratchUiWorldPosition);
      this.scratchUiTarget.set(camera.position.x, this.scratchUiWorldPosition.y, camera.position.z);
      if (this.scratchUiTarget.distanceToSquared(this.scratchUiWorldPosition) < 1e-9) continue;
      this.scratchUiMatrix.lookAt(
        this.scratchUiWorldPosition,
        this.scratchUiTarget,
        this.scratchUiUp,
      );
      this.scratchUiWorldQuaternion.setFromRotationMatrix(this.scratchUiMatrix);
      element.parent.getWorldQuaternion(this.scratchUiParentQuaternion).invert();
      this.scratchUiLocalQuaternion
        .copy(this.scratchUiParentQuaternion)
        .multiply(this.scratchUiWorldQuaternion)
        .multiply(this.scratchUiFacingCorrection);
      element.quaternion.copy(this.scratchUiLocalQuaternion);
    }
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
        this.#applyDepthEffects();
        this.#updateFrameVisibility();
  }

  #updateFrameVisibility() {
    // TODO: Consired removing the frame completely?
    this.frame.visible = false;
    // const material = this.surface.material;
    // this.frame.visible = !(material.alphaMap && material.transparent);
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

  activateSurface(uv, context = null) {
    if (this.panel.minimized) {
      this.callbacks.onAction?.(this.panel.id, "toggle-minimize");
      return;
    }
    if (!this.panel.media?.selectedId && !this.panel.currentMedia) {
      this.callbacks.onAction?.(this.panel.id, "browse");
      return;
    }
    if (context?.source === "xr-select") return;
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
    this.clearOverlayScene();
    this.#clearPendingImageTap();
    if (this.editorFrame != null) cancelAnimationFrame(this.editorFrame);
    this.#clearMaskTextures();
    this.depthMapTexture?.dispose();
    this.depthMapTexture = null;
    if (this.surface.geometry !== this.surfaceFlatGeometry) {
      this.surface.geometry.dispose();
      this.surface.geometry = this.surfaceFlatGeometry;
    }
    this.mediaTexture.dispose();
    disposeObject(this);
  }

  tick(time, camera = this.activeViewCamera) {
    this.#alignUiToCamera(camera);
    if (this.overlayScene) this.#syncOverlayGroups(camera);
    this.#applyDepthEffects();
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
