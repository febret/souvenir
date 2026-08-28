import * as THREE from "three";

import {
  makeButton,
  makeLabelTexture,
  setButtonState,
} from "../canvas-ui.js";

import {
  COLOR_SWATCHES,
  DEPTH_LABEL_HEIGHT,
  PADDING,
  PANEL_WIDTH,
  SWATCH_SIZE,
} from "./constants.js";

/**
 * Stateless widget builders shared by the section renderers. `markPanelButton`
 * stamps panel ownership and disables gesture-target behavior.
 */
export function createWidgetFactory({ panelId }) {
  function markPanelButton(button) {
    button.userData.panelId = panelId;
    button.userData.gestureTarget = false;
  }

  function button(label, action, { x, y, width, height = 0.052 }) {
    const b = makeButton(label, action, {
      width,
      height,
      textureWidth: 560,
      textureHeight: 160,
      font: "700 56px system-ui, sans-serif",
      padding: 8,
      radius: 14,
    });
    b.position.set(x, y, 0.004);
    markPanelButton(b);
    return b;
  }

  function sectionLabel(text, y) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(PANEL_WIDTH - PADDING * 2, DEPTH_LABEL_HEIGHT),
      new THREE.MeshBasicMaterial({
        map: makeLabelTexture(text, {
          width: 840,
          height: 80,
          align: "left",
          padding: 4,
          font: "700 40px system-ui, sans-serif",
        }),
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    mesh.position.set(0, y, 0.003);
    mesh.userData.gestureTarget = false;
    return mesh;
  }

  function colorSwatch(hex, action, { x, y, selected = false }) {
    const b = makeButton("", action, {
      width: SWATCH_SIZE,
      height: SWATCH_SIZE,
      background: hex,
      border: selected ? "#8ce8af" : "#40534d",
      shape: "circle",
      textureWidth: 128,
      textureHeight: 128,
    });
    b.position.set(x, y, 0.004);
    b.scale.setScalar(selected ? 1.18 : 1);
    b.userData.colorSwatch = true;
    markPanelButton(b);
    return b;
  }

  return { button, sectionLabel, colorSwatch };
}

export function addTitle(content, topY) {
  const title = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_WIDTH - PADDING * 2, 0.06),
    new THREE.MeshBasicMaterial({
      map: makeLabelTexture("OPTIONS", {
        width: 900,
        height: 130,
        font: "700 72px system-ui, sans-serif",
        padding: 4,
      }),
      transparent: true,
      side: THREE.DoubleSide,
    }),
  );
  title.position.set(0, topY - 0.06 / 2, 0.002);
  title.userData.gestureTarget = false;
  content.add(title);
}

export function addOptionsRow(content, widgets, y) {
  for (const [index, [label, action]] of [
    ["Mask", "toggle-mask"],
    ["Edit BG", "edit-erase-mask"],
    ["3D Mode", "toggle-3d-mode"],
  ].entries()) {
    content.add(widgets.button(label, action, {
      x: (index - 1) * 0.255,
      y,
      width: 0.23,
    }));
  }
}

export function addSaveModeSection(content, widgets, { labelY, rowY, saveMode }) {
  content.add(widgets.sectionLabel("Panel save mode", labelY));
  for (const [index, [label, value]] of [
    ["Disabled", "disabled"],
    ["Scale", "scale"],
    ["Full", "full"],
  ].entries()) {
    const b = widgets.button(label, `set-save-mode:${value}`, {
      x: (index - 1) * 0.255,
      y: rowY,
      width: 0.23,
      height: 0.05,
    });
    setButtonState(b, { active: saveMode === value });
    content.add(b);
  }
}

export function addDepthSection(content, widgets, {
  labelY,
  effectButtonY,
  deleteDepthButtonY,
  settings,
}) {
  content.add(widgets.sectionLabel("Depth intensity", labelY));
  for (const [index, [label, action]] of [
    ["Soft depth", "toggle-soft-depth"],
    ["Fade depth", "toggle-fade-depth"],
    ["Focus blur", "toggle-focus-blur"],
  ].entries()) {
    const b = widgets.button(label, action, {
      x: (index - 1) * 0.255,
      y: effectButtonY,
      width: 0.23,
    });
    const active = action === "toggle-soft-depth" ? Boolean(settings.softDepthEnabled)
      : action === "toggle-fade-depth" ? Boolean(settings.fadeDepthEnabled)
      : Boolean(settings.focusBlurEnabled);
    setButtonState(b, { active });
    content.add(b);
  }
  content.add(widgets.button("Delete depth", "delete-depth-mask", {
    x: 0,
    y: deleteDepthButtonY,
    width: 0.34,
    height: 0.05,
  }));
}

export function addLightingSection(content, widgets, layout, settings) {
  content.add(widgets.sectionLabel("Lighting", layout.lightingLabelY));

  const lightFxButton = widgets.button("Light FX", "toggle-light-fx", {
    x: -0.255,
    y: layout.lightFxY,
    width: 0.23,
  });
  setButtonState(lightFxButton, { active: Boolean(settings.lightFxEnabled) });
  content.add(lightFxButton);

  // Light direction: 2 rows of 3
  const DIRECTIONS = [
    ["Top", "top"],
    ["Top-Left", "top-left"],
    ["Top-Right", "top-right"],
    ["Front", "front"],
    ["Left", "left"],
    ["Right", "right"],
  ];
  for (const [rowStart, y] of [[0, layout.lightDirRow1Y], [3, layout.lightDirRow2Y]]) {
    for (const [index, [label, value]] of DIRECTIONS.slice(rowStart, rowStart + 3).entries()) {
      const btn = widgets.button(label, `set-light-direction:${value}`, {
        x: (index - 1) * 0.255,
        y,
        width: 0.23,
        height: 0.05,
      });
      setButtonState(btn, { active: settings.lightDirection === value });
      content.add(btn);
    }
  }

  // Light color
  content.add(widgets.sectionLabel("Light color", layout.lightColorLabelY));
  addColorSwatches(content, widgets, layout.lightColorRowY, `set-light-color`, settings.lightColor ?? "white");

  // Ambient color
  content.add(widgets.sectionLabel("Ambient color", layout.ambientColorLabelY));
  addColorSwatches(content, widgets, layout.ambientColorRowY, `set-ambient-color`, settings.ambientColor ?? "white");

  // Ambient intensity
  content.add(widgets.sectionLabel("Ambient intensity", layout.ambientIntLabelY));
  const INTENSITY_STEPS = [
    ["0%", 0],
    ["25%", 0.25],
    ["50%", 0.5],
    ["75%", 0.75],
    ["100%", 1],
  ];
  for (const [index, [label, value]] of INTENSITY_STEPS.entries()) {
    const btn = widgets.button(label, `set-ambient-intensity:${value}`, {
      x: (index - 2) * 0.158,
      y: layout.ambientIntY,
      width: 0.145,
      height: 0.05,
    });
    const curIntensity = settings.ambientIntensity ?? 0.5;
    setButtonState(btn, { active: Math.round(curIntensity * 100) === Math.round(value * 100) });
    content.add(btn);
  }
}

function addColorSwatches(content, widgets, y, actionPrefix, selectedValue) {
  for (const [index, [value, hex]] of COLOR_SWATCHES.entries()) {
    content.add(widgets.colorSwatch(hex, `${actionPrefix}:${value}`, {
      x: (index - 2.5) * 0.12,
      y,
      selected: selectedValue === value,
    }));
  }
}
