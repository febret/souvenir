import * as THREE from "three";

import { makeCanvasTexture, roundedRect } from "./canvas-ui.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const TEXTURE_WIDTH = 720;
const TRACK_LEFT = 42;
const TRACK_RIGHT = TEXTURE_WIDTH - 42;

export class SpatialSlider extends THREE.Group {
  constructor({
    title,
    action,
    min,
    max,
    step,
    value,
    width = 0.3,
    height = 0.052,
    formatValue = String,
    onChange,
  }) {
    super();
    this.title = title;
    this.min = min;
    this.max = max;
    this.step = step;
    this.value = value;
    this.formatValue = formatValue;
    this.onChange = onChange;

    this.track = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({
        transparent: true,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    this.track.userData.interactive = true;
    this.track.userData.kind = "slider";
    this.track.userData.action = action;
    this.track.userData.label = title;
    this.track.userData.gestureTarget = false;
    this.track.userData.drawTarget = {
      onDraw: (phase, uv) => {
        if (phase === "end") return;
        const next = this.#valueFromPosition(uv?.x);
        this.setValue(next);
        this.onChange?.(next);
      },
    };
    this.add(this.track);
    this.setValue(value);
  }

  #valueFromPosition(position) {
    const texturePosition = clamp(Number(position) || 0, 0, 1) * TEXTURE_WIDTH;
    const ratio = clamp(
      (texturePosition - TRACK_LEFT) / (TRACK_RIGHT - TRACK_LEFT),
      0,
      1,
    );
    const raw = this.min + ratio * (this.max - this.min);
    const steps = Math.round((raw - this.min) / this.step);
    return clamp(this.min + steps * this.step, this.min, this.max);
  }

  setValue(value) {
    this.value = clamp(Number(value) || 0, this.min, this.max);
    const previous = this.track.material.map;
    const progress = (this.value - this.min) / (this.max - this.min);
    this.track.material.map = makeCanvasTexture({
      width: TEXTURE_WIDTH,
      height: 124,
      resolutionScale: 1.5,
      draw: (context, canvas) => {
        context.clearRect(0, 0, canvas.width, canvas.height);
        roundedRect(context, 2, 2, canvas.width - 4, canvas.height - 4, 24);
        context.fillStyle = "#17211f";
        context.fill();
        context.strokeStyle = "#40534d";
        context.lineWidth = 3;
        context.stroke();

        const left = TRACK_LEFT;
        const right = TRACK_RIGHT;
        const y = 88;
        context.lineCap = "round";
        context.lineWidth = 14;
        context.strokeStyle = "#40534d";
        context.beginPath();
        context.moveTo(left, y);
        context.lineTo(right, y);
        context.stroke();
        context.strokeStyle = "#ff72ad";
        context.beginPath();
        context.moveTo(left, y);
        context.lineTo(left + (right - left) * progress, y);
        context.stroke();
        context.fillStyle = "#fff";
        context.beginPath();
        context.arc(left + (right - left) * progress, y, 17, 0, Math.PI * 2);
        context.fill();

        context.fillStyle = "#eaf3ef";
        context.font = "600 28px system-ui, sans-serif";
        context.textAlign = "left";
        context.textBaseline = "middle";
        context.fillText(`${this.title} ${this.formatValue(this.value)}`, 28, 31);
      },
    });
    this.track.material.needsUpdate = true;
    this.track.userData.value = this.value;
    previous?.dispose();
  }
}
