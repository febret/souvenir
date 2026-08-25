import * as THREE from "three";

import {
  DEFAULT_ENVIRONMENT_MODE,
  ENVIRONMENT_MODE_CONFIG,
  normalizeEnvironmentMode,
} from "../core/environment-mode.js";

const OVERLAY_VERTEX_SHADER = `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const OVERLAY_FRAGMENT_SHADER = `
  uniform vec3 uColor;
  uniform vec3 uAccentColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uUnderwater;
  varying vec3 vDirection;

  void main() {
    // This simulates waves with animated overlay opacity/color; it never samples or warps passthrough.
    float bands = sin((vDirection.x * 2.2 + vDirection.y * 3.1) + uTime * 0.28);
    float caustics = smoothstep(0.78, 0.98, bands * 0.5 + 0.5);
    vec3 color = mix(uColor, uAccentColor, caustics * 0.22 * uUnderwater);
    float opacity = uOpacity + caustics * 0.055 * uUnderwater;
    gl_FragColor = vec4(color, opacity);
  }
`;

function colorValue(value) {
  return new THREE.Color(value ?? 0x000000);
}

export function cameraWorldCenter(
  camera,
  target = new THREE.Vector3(),
  eyePosition = new THREE.Vector3(),
) {
  const cameras = Array.isArray(camera?.cameras) ? camera.cameras : [];
  if (cameras.length === 0) {
    camera?.updateMatrixWorld?.();
    return camera?.getWorldPosition ? camera.getWorldPosition(target) : target.set(0, 0, 0);
  }
  target.set(0, 0, 0);
  for (const eye of cameras) {
    eye.updateMatrixWorld?.();
    eye.getWorldPosition(eyePosition);
    target.add(eyePosition);
  }
  return target.multiplyScalar(1 / cameras.length);
}

/**
 * Renders a transparent, camera-following overlay before the app scene.
 * The pass is separate so panels and media never receive this tint.
 */
export class EnvironmentEffects {
  constructor(mode = DEFAULT_ENVIRONMENT_MODE) {
    this.scene = new THREE.Scene();
    this.scene.name = "environment-background-effects";
    this.scene.background = null;
    this.renderPasses = { background: 0, main: 0, depthClears: 0 };
    this.metadata = {
      pass: "background-before-main",
      appliesTo: "background-only",
      samplesCameraFeed: false,
      underwaterAnimation: "slow animated overlay opacity/color",
      environmentBlendMode: "unknown",
      passthroughSupport: "unknown",
      notice: "Passthrough blend mode has not been reported by this session.",
    };

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.BackSide,
      uniforms: {
        uColor: { value: colorValue() },
        uAccentColor: { value: colorValue() },
        uOpacity: { value: 0 },
        uTime: { value: 0 },
        uUnderwater: { value: 0 },
      },
      vertexShader: OVERLAY_VERTEX_SHADER,
      fragmentShader: OVERLAY_FRAGMENT_SHADER,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(20, 48, 32), this.material);
    this.eyePosition = new THREE.Vector3();
    this.mesh.name = "environment-background-overlay";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.scene.add(this.mesh);
    this.setMode(mode);
  }

  setMode(mode) {
    this.mode = normalizeEnvironmentMode(mode);
    const config = ENVIRONMENT_MODE_CONFIG[this.mode];
    this.mesh.visible = this.mode !== DEFAULT_ENVIRONMENT_MODE;
    this.material.uniforms.uColor.value.copy(colorValue(config.color));
    this.material.uniforms.uAccentColor.value.copy(colorValue(config.accentColor ?? config.color));
    this.material.uniforms.uOpacity.value = config.opacity;
    this.material.uniforms.uUnderwater.value = config.animated ? 1 : 0;
    return this.mode;
  }

  update(time, camera) {
    cameraWorldCenter(camera, this.mesh.position, this.eyePosition);
    this.material.uniforms.uTime.value = (Number.isFinite(time) ? time : 0) * 0.001;
  }

  setEnvironmentBlendMode(blendMode) {
    const mode = typeof blendMode === "string" ? blendMode : "unknown";
    this.metadata.environmentBlendMode = mode;
    if (mode === "alpha-blend") {
      this.metadata.passthroughSupport = "supported";
      this.metadata.notice = "";
    } else if (mode === "additive") {
      this.metadata.passthroughSupport = "best-effort";
      this.metadata.notice = "Additive blending cannot reliably darken passthrough.";
    } else if (mode === "opaque") {
      this.metadata.passthroughSupport = "unavailable";
      this.metadata.notice = "Opaque XR blending does not provide camera passthrough.";
    } else {
      this.metadata.passthroughSupport = "unknown";
      this.metadata.notice = "Passthrough blend mode has not been reported by this session.";
    }
    return mode;
  }

  render(renderer, mainScene, camera, time) {
    const viewCamera = renderer.xr?.isPresenting
      ? renderer.xr.getCamera()
      : camera;
    this.update(time, viewCamera);
    const previousAutoClear = renderer.autoClear;
    try {
      renderer.autoClear = false;
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      if (!this.mesh.visible) {
        renderer.render(mainScene, camera);
        this.renderPasses.main += 1;
        return;
      }
      renderer.render(this.scene, camera);
      this.renderPasses.background += 1;
      renderer.clearDepth();
      this.renderPasses.depthClears += 1;
      renderer.render(mainScene, camera);
      this.renderPasses.main += 1;
    } finally {
      renderer.autoClear = previousAutoClear;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.mesh);
  }
}
