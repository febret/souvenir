import * as THREE from "three";

import { makeCanvasTexture, roundedRect } from "./canvas-ui.js";
import { cameraWorldCenter } from "./environment-effects.js";

const BASE_WIDTH = 1.25;
const BASE_HEIGHT = 0.22;

function captionTexture(text) {
  return makeCanvasTexture({
    width: 1400,
    height: 250,
    resolutionScale: 1.5,
    draw(context, canvas) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      // roundedRect(context, 8, 8, canvas.width - 16, canvas.height - 16, 34);
      // context.fillStyle = "rgba(7, 12, 11, 0.88)";
      // context.fill();
      // context.strokeStyle = "rgba(174, 238, 198, 0.7)";
      // context.lineWidth = 5;
      // context.stroke();
      context.fillStyle = "#f5fbf8";
      context.font = "650 54px impact, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 90);
    },
  });
}

export class CaptionView extends THREE.Mesh {
  constructor() {
    super(
      new THREE.PlaneGeometry(BASE_WIDTH, BASE_HEIGHT),
      new THREE.MeshBasicMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    this.name = "commentary-caption";
    this.frustumCulled = false;
    this.renderOrder = 1000;
    this.currentText = "";
    this.visible = false;
  }

  setText(text) {
    const normalized = String(text ?? "").trim();
    if (normalized === this.currentText) return;
    this.currentText = normalized;
    const previous = this.material.map;
    this.material.map = normalized ? captionTexture(normalized) : null;
    this.material.needsUpdate = true;
    this.visible = Boolean(normalized);
    previous?.dispose();
  }

  setStyle({ size = 1, transparency = 0.1 } = {}) {
    const scale = Math.min(2, Math.max(0.5, Number(size) || 1));
    this.scale.setScalar(scale);
    this.material.opacity = 1 - Math.min(0.8, Math.max(0, Number(transparency) || 0));
  }

  updatePose(camera, distance = 1.2) {
    const viewCamera = camera?.cameras?.[0] ?? camera;
    if (!viewCamera) return;
    const position = cameraWorldCenter(camera, new THREE.Vector3());
    const orientation = viewCamera.getWorldQuaternion(new THREE.Quaternion());
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(orientation);
    this.position.copy(position).addScaledVector(
      forward,
      Math.min(3, Math.max(0.5, Number(distance) || 1.2)),
    );
    this.quaternion.copy(orientation);
  }

  dispose() {
    this.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
  }
}
