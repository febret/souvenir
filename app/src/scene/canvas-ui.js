import * as THREE from "three";

const DEFAULT_FONT = "600 38px system-ui, sans-serif";
export const INTERACTION_LAYER = 1;

export function markInteractive(object) {
  object.userData.interactive = true;
  object.layers.enable(INTERACTION_LAYER);
  return object;
}

export function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.closePath();
}

export function makeCanvasTexture({
  width = 1024,
  height = 640,
  draw,
  colorSpace = THREE.SRGBColorSpace,
  resolutionScale = 1,
}) {
  const scale = Math.max(1, Number.isFinite(resolutionScale) ? resolutionScale : 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  context.scale(scale, scale);
  draw(context, { width, height });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = colorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  texture.userData.canvasSize = { width: canvas.width, height: canvas.height };
  texture.userData.logicalSize = { width, height };
  texture.userData.resolutionScale = scale;
  return texture;
}

export function makeLabelTexture(
  text,
  {
    width = 512,
    height = 128,
    background = "#17211f",
    foreground = "#eaf3ef",
    border = "#40534d",
    font = DEFAULT_FONT,
    align = "center",
    padding = 30,
    resolutionScale = 1,
  } = {},
) {
  return makeCanvasTexture({
    width,
    height,
    resolutionScale,
    draw(context) {
      context.clearRect(0, 0, width, height);
      roundedRect(context, 2, 2, width - 4, height - 4, 22);
      context.fillStyle = background;
      context.fill();
      context.strokeStyle = border;
      context.lineWidth = 3;
      context.stroke();
      context.fillStyle = foreground;
      context.font = font;
      context.textAlign = align;
      context.textBaseline = "middle";
      context.fillText(
        text,
        align === "left" ? padding : width / 2,
        height / 2,
        width - padding * 2,
      );
    },
  });
}

export function makeButton(
  label,
  action,
  {
    width = 0.2,
    height = 0.065,
    background = "#17211f",
    foreground = "#eaf3ef",
    border = "#40534d",
    textureWidth = 512,
    textureHeight = 128,
    textureResolutionScale = 1,
  } = {},
) {
  const texture = makeLabelTexture(label, {
    width: textureWidth,
    height: textureHeight,
    background,
    foreground,
    border,
    resolutionScale: textureResolutionScale,
  });
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
  });
  const button = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  button.userData.action = action;
  markInteractive(button);
  button.userData.kind = "button";
  button.userData.label = label;
  button.userData.textureSize = texture.userData.canvasSize;
  return button;
}

export function setButtonState(button, { active = false, hovered = false } = {}) {
  const scale = hovered ? 1.06 : 1;
  button.scale.setScalar(scale);
  button.material.color.set(active ? 0xb7f3ca : 0xffffff);
}

export function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose();
    if (Array.isArray(child.material)) {
      for (const material of child.material) {
        material.map?.dispose();
        material.dispose();
      }
    } else if (child.material) {
      child.material.map?.dispose();
      child.material.dispose();
    }
  });
}
