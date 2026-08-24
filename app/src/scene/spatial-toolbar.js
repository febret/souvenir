import * as THREE from "three";

import {
  ENVIRONMENT_MODE_DESCRIPTORS,
  ENVIRONMENT_MODE_LABELS,
  normalizeEnvironmentMode,
} from "../core/environment-mode.js";
import {
  disposeObject,
  makeButton,
  makeCanvasTexture,
  roundedRect,
  setButtonState,
} from "./canvas-ui.js";

export const TOOLBAR_WIDTH = 1.06;
export const TOOLBAR_HEIGHT = 0.22;
export const TOOLBAR_TEXTURE_RESOLUTION = 2;
const TOOLBAR_TITLE = "PANEL CONTROLS";
const MENU_WIDTH = 0.46;
const MENU_HEIGHT = 0.49;

function makeToolbarTexture() {
  return makeCanvasTexture({
    width: 1200,
    height: 300,
    resolutionScale: TOOLBAR_TEXTURE_RESOLUTION,
    draw(context, canvas) {
      const titleHeight = 82;

      context.clearRect(0, 0, canvas.width, canvas.height);
      roundedRect(context, 3, 3, canvas.width - 6, canvas.height - 6, 24);
      context.fillStyle = "#101918";
      context.fill();

      context.save();
      context.clip();
      context.fillStyle = "#1b2a27";
      context.fillRect(0, 0, canvas.width, titleHeight);
      context.restore();

      context.strokeStyle = "#71847d";
      context.lineWidth = 4;
      context.stroke();
      context.beginPath();
      context.moveTo(4, titleHeight);
      context.lineTo(canvas.width - 4, titleHeight);
      context.strokeStyle = "#527067";
      context.lineWidth = 3;
      context.stroke();

      context.fillStyle = "#eff8f3";
      context.font = "700 34px system-ui, sans-serif";
      context.textAlign = "left";
      context.textBaseline = "middle";
      context.letterSpacing = "2px";
      context.fillText(TOOLBAR_TITLE, 34, titleHeight / 2);
      context.letterSpacing = "0px";
    },
  });
}

function exposeTextureSize(mesh) {
  const texture = mesh.material.map;
  mesh.userData.textureSize = texture.userData.canvasSize;
  mesh.userData.textureLogicalSize = texture.userData.logicalSize;
  mesh.userData.textureResolutionScale = texture.userData.resolutionScale;
}

export class SpatialToolbar extends THREE.Group {
  constructor({ environmentMode } = {}) {
    super();
    this.name = "spatial-toolbar";
    this.userData.title = TOOLBAR_TITLE;
    this.interactionTarget = {
      type: "spatial-toolbar",
      onGesture: (gesture) => this.applyGesture(gesture),
    };
    this.userData.gestureTarget = this.interactionTarget;
    this.environmentMode = normalizeEnvironmentMode(environmentMode);

    this.backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(TOOLBAR_WIDTH, TOOLBAR_HEIGHT),
      new THREE.MeshBasicMaterial({
        map: makeToolbarTexture(),
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    this.backdrop.name = "spatial-toolbar-surface";
    this.backdrop.position.z = -0.01;
    this.backdrop.userData.interactive = true;
    this.backdrop.userData.kind = "toolbar-surface";
    this.backdrop.userData.title = TOOLBAR_TITLE;
    exposeTextureSize(this.backdrop);
    this.add(this.backdrop);

    this.controls = new THREE.Group();
    this.controls.name = "spatial-toolbar-controls";
    this.controls.position.z = 0.01;
    this.add(this.controls);

    this.addButton = makeButton("Add panel", "add-panel", {
      width: 0.2,
      height: 0.065,
      textureResolutionScale: TOOLBAR_TEXTURE_RESOLUTION,
    });
    this.addButton.position.set(-0.39, -0.045, 0);
    this.addButton.userData.gestureTarget = false;
    exposeTextureSize(this.addButton);
    this.controls.add(this.addButton);

    this.removeButton = makeButton("Remove", "remove-panel", {
      width: 0.18,
      height: 0.065,
      foreground: "#ffc6b7",
      border: "#6d453b",
      textureResolutionScale: TOOLBAR_TEXTURE_RESOLUTION,
    });
    this.removeButton.position.set(0.39, -0.045, 0);
    this.removeButton.userData.gestureTarget = false;
    exposeTextureSize(this.removeButton);
    this.controls.add(this.removeButton);

    this.environmentButton = makeButton("Set Environment", "toggle-environment-menu", {
      width: 0.24,
      height: 0.065,
      textureResolutionScale: TOOLBAR_TEXTURE_RESOLUTION,
    });
    this.environmentButton.position.set(0, -0.045, 0);
    this.environmentButton.userData.gestureTarget = false;
    exposeTextureSize(this.environmentButton);
    this.controls.add(this.environmentButton);

    this.commentaryButton = makeButton("Commentary", "toggle-commentary", {
      width: 0.22,
      textureResolutionScale: TOOLBAR_TEXTURE_RESOLUTION,
    });
    this.commentaryButton.position.set(-0.16, -0.045, 0);
    this.commentaryButton.userData.gestureTarget = false;
    this.commentaryButton.userData.activationOnly = true;
    exposeTextureSize(this.commentaryButton);
    this.controls.add(this.commentaryButton);

    this.environmentButton.position.set(0.16, -0.045, 0);
    this.environmentMenu = this.#createEnvironmentMenu();
    this.environmentMenu.position.set(0, -0.39, 0.015);
    this.environmentMenu.visible = false;
    this.add(this.environmentMenu);
    this.setEnvironmentMode(this.environmentMode);
    this.setCommentaryState({ available: false, enabled: false, playing: false });
  }

  #createEnvironmentMenu() {
    const menu = new THREE.Group();
    menu.name = "environment-menu";
    menu.userData.title = "ENVIRONMENT";
    menu.userData.gestureTarget = false;

    const backdropTexture = makeCanvasTexture({
      width: 720,
      height: 760,
      resolutionScale: TOOLBAR_TEXTURE_RESOLUTION,
      draw(context, canvas) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        roundedRect(context, 3, 3, canvas.width - 6, canvas.height - 6, 28);
        context.fillStyle = "#101918";
        context.fill();
        context.strokeStyle = "#71847d";
        context.lineWidth = 4;
        context.stroke();
        context.fillStyle = "#eff8f3";
        context.font = "700 36px system-ui, sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText("ENVIRONMENT", canvas.width / 2, 58);
      },
    });
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(MENU_WIDTH, MENU_HEIGHT),
      new THREE.MeshBasicMaterial({ map: backdropTexture, transparent: true, side: THREE.DoubleSide }),
    );
    backdrop.name = "environment-menu-background";
    backdrop.position.z = -0.01;
    backdrop.userData.gestureTarget = false;
    backdrop.userData.interactive = true;
    backdrop.userData.kind = "environment-menu-background";
    backdrop.userData.title = "ENVIRONMENT";
    exposeTextureSize(backdrop);
    menu.add(backdrop);

    this.environmentButtons = new Map();
    for (const [index, descriptor] of ENVIRONMENT_MODE_DESCRIPTORS.entries()) {
      const button = makeButton(
        descriptor.label,
        `set-environment:${descriptor.mode}`,
        {
          width: 0.37,
          height: 0.055,
          textureResolutionScale: TOOLBAR_TEXTURE_RESOLUTION,
        },
      );
      button.name = `environment-${descriptor.mode}`;
      button.position.set(0, 0.145 - index * 0.073, 0.01);
      button.userData.gestureTarget = false;
      button.userData.environmentMode = descriptor.mode;
      exposeTextureSize(button);
      this.environmentButtons.set(descriptor.mode, button);
      menu.add(button);
    }
    return menu;
  }

  setEnvironmentMode(mode) {
    this.environmentMode = normalizeEnvironmentMode(mode);
    for (const [buttonMode, button] of this.environmentButtons) {
      const selected = buttonMode === this.environmentMode;
      button.userData.selected = selected;
      button.userData.label = ENVIRONMENT_MODE_LABELS[buttonMode];
      setButtonState(button, { active: selected });
    }
    return this.environmentMode;
  }

  setEnvironmentMenuOpen(open) {
    this.environmentMenu.visible = Boolean(open);
    this.environmentButton.userData.expanded = this.environmentMenu.visible;
    return this.environmentMenu.visible;
  }

  toggleEnvironmentMenu() {
    return this.setEnvironmentMenuOpen(!this.environmentMenu.visible);
  }

  setCommentaryState({ available = false, enabled = false, playing = false } = {}) {
    const state = {
      available: Boolean(available),
      enabled: Boolean(enabled) && Boolean(available),
      playing: Boolean(playing) && Boolean(enabled) && Boolean(available),
    };
    this.commentaryState = state;
    this.commentaryButton.userData.available = state.available;
    this.commentaryButton.userData.enabled = state.enabled;
    this.commentaryButton.userData.playing = state.playing;
    this.commentaryButton.userData.disabled = !state.available;
    this.commentaryButton.userData.inactive = !state.available || !state.enabled;
    this.commentaryButton.userData.interactive = state.available;
    this.commentaryButton.material.color.set(
      !state.available ? 0x66716d : state.playing ? 0xb7f3ca : state.enabled ? 0xe5cf8b : 0xffffff,
    );
    return { ...state };
  }

  applyGesture(gesture) {
    if (gesture?.hands !== 1) return;
    const translation = gesture.translation ?? {};
    const rotation = gesture.rotation ?? {};
    this.position.x += Number.isFinite(translation.x) ? translation.x : 0;
    this.position.y += Number.isFinite(translation.y) ? translation.y : 0;
    this.position.z += Number.isFinite(translation.z) ? translation.z : 0;
    this.rotation.x += Number.isFinite(rotation.x) ? rotation.x : 0;
    this.rotation.y += Number.isFinite(rotation.y) ? rotation.y : 0;
    this.rotation.z += Number.isFinite(rotation.z) ? rotation.z : 0;
  }

  dispose() {
    disposeObject(this);
  }
}
