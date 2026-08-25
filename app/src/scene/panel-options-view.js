import * as THREE from "three";

import {
  disposeObject,
  markInteractive,
  makeButton,
  makeLabelTexture,
  setButtonState,
} from "./canvas-ui.js";

const SAVE_MODE_DEFINITIONS = [
  ["Disabled", "disabled"],
  ["Scale", "scale"],
  ["Full", "full"],
];

/**
 * Owns the dynamic options chrome for one panel. The group is rebuilt only when
 * layout, save mode, tag definitions, or tag selection changes.
 */
export class PanelOptionsView extends THREE.Group {
  constructor(panelId) {
    super();
    this.panelId = panelId;
    this.signature = "";
    this.name = "panel-options";
    this.visible = false;
  }

  update({ width, height, saveMode, tagDefinitions, mediaTagIds, depthOffset }) {
    const definitions = Array.isArray(tagDefinitions) ? tagDefinitions : [];
    const selectedIds = Array.isArray(mediaTagIds) ? mediaTagIds : [];
    const signature = JSON.stringify({
      width,
      height,
      saveMode,
      tags: definitions.map(({ id, name }) => [id, name]),
      selected: selectedIds,
    });
    if (signature === this.signature) {
      this.position.z = depthOffset;
      return false;
    }
    this.signature = signature;
    disposeObject(this);
    this.clear();

    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(0.74, 0.5),
      new THREE.MeshBasicMaterial({
        color: 0x101817,
        transparent: true,
        opacity: 0.96,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    backdrop.position.set(0, 0, -0.01);
    backdrop.userData.gestureTarget = false;
    markInteractive(backdrop);
    this.add(backdrop);

    const title = new THREE.Mesh(
      new THREE.PlaneGeometry(0.68, 0.06),
      new THREE.MeshBasicMaterial({
        map: makeLabelTexture("OPTIONS", { width: 840, height: 120 }),
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    title.position.set(0, 0.22, 0.002);
    title.userData.gestureTarget = false;
    this.add(title);

    const optionsRow = [
      ["Mask", "toggle-mask"],
      ["Edit BG", "edit-erase-mask"],
      ["3D Mode", "toggle-3d-mode"],
    ];
    for (const [index, [label, action]] of optionsRow.entries()) {
      this.add(this.#button(label, action, {
        x: (index - 1) * 0.235,
        y: 0.145,
        width: 0.21,
      }));
    }

    const saveLabel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.68, 0.04),
      new THREE.MeshBasicMaterial({
        map: makeLabelTexture("Panel save mode", {
          width: 760,
          height: 80,
          align: "left",
          padding: 16,
          font: "600 28px system-ui, sans-serif",
        }),
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    saveLabel.position.set(0, 0.085, 0.003);
    saveLabel.userData.gestureTarget = false;
    this.add(saveLabel);
    for (const [index, [label, value]] of SAVE_MODE_DEFINITIONS.entries()) {
      const button = this.#button(label, `set-save-mode:${value}`, {
        x: (index - 1) * 0.235,
        y: 0.035,
        width: 0.21,
        height: 0.042,
      });
      setButtonState(button, { active: saveMode === value });
      this.add(button);
    }

    const columns = 3;
    const rows = Math.max(1, Math.ceil(definitions.length / columns));
    const cellHeight = rows > 3 ? 0.042 : 0.05;
    const startY = -0.04;
    for (const [index, definition] of definitions.entries()) {
      const selected = selectedIds.includes(definition.id);
      const button = makeButton(
        `${selected ? "✓ " : ""}${definition.name}`,
        `toggle-media-tag:${definition.id}`,
        {
          width: 0.225,
          height: cellHeight,
          textureWidth: 540,
          background: selected ? "#294c38" : "#17211f",
          border: selected ? "#8ce8af" : "#40534d",
        },
      );
      button.position.set(
        ((index % columns) - 1) * 0.235,
        startY - Math.floor(index / columns) * (cellHeight + 0.01),
        0.004,
      );
      this.#markPanelButton(button);
      this.add(button);
    }

    const minY = startY - rows * (cellHeight + 0.01) - 0.03;
    const scale = Math.min(1, Math.max(0.5, (width - 0.03) / 0.76));
    this.scale.setScalar(scale);
    this.position.set(width / 2 + 0.4 * scale, 0, depthOffset);
    const desiredHeight = 0.31 + rows * (cellHeight + 0.01);
    backdrop.scale.y = Math.min(1.4, Math.max(1, desiredHeight / 0.5));
    backdrop.position.y = (0.2 + minY) / 2;
    return true;
  }

  updateControlStates({
    maskAvailable,
    mediaLoaded,
    mediaType,
    maskEnabled,
    admEnabled,
    admPromptVisible,
  }) {
    for (const control of this.children) {
      const action = control.userData?.action;
      if (!action) continue;
      const inactive = (action === "toggle-mask" && !maskAvailable)
        || (action === "edit-erase-mask" && !mediaLoaded)
        || (action === "toggle-3d-mode" && mediaType !== "image")
        || admPromptVisible;
      const active = (action === "toggle-mask" && maskEnabled && maskAvailable)
        || (action === "toggle-3d-mode" && admEnabled);
      control.material.color.set(inactive ? 0x5f6b67 : active ? 0xaaf1c3 : 0xffffff);
    }
  }

  #button(label, action, { x, y, width, height = 0.045 }) {
    const button = makeButton(label, action, {
      width,
      height,
      textureWidth: 460,
    });
    button.position.set(x, y, 0.004);
    this.#markPanelButton(button);
    return button;
  }

  #markPanelButton(button) {
    button.userData.panelId = this.panelId;
    button.userData.gestureTarget = false;
  }
}
