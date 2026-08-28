import * as THREE from "three";

import { createRayDragState, solveRayDragPose } from "../core/ray-drag.js";
import {
  createTwoHandRayDragState,
  solveTwoHandRayDragPose,
} from "../core/two-hand-ray-drag.js";
import { INTERACTION_LAYER } from "./canvas-ui.js";

/**
 * Updates an XR raycaster and returns a snapshot that remains valid after the
 * raycaster is next used for another controller.
 */
export function snapshotXrControllerRay(raycaster, controller) {
  if (!setXrControllerRay(raycaster, controller)) return null;
  return {
    rayOrigin: raycaster.ray.origin.clone(),
    rayDirection: raycaster.ray.direction.clone(),
  };
}

function setXrControllerRay(raycaster, controller) {
  if (!controller) return false;
  raycaster.setFromXRController(controller);
  return true;
}

export class InteractionController {
  constructor({ renderer, camera, scene, overlayScene, canvas, onActivate, onGesture, onFocus }) {
    this.renderer = renderer;
    this.camera = camera;
    this.scene = scene;
    this.overlayScene = overlayScene ?? null;
    this.canvas = canvas;
    this.onActivate = onActivate;
    this.onGesture = onGesture;
    this.onFocus = onFocus;
    this.raycaster = new THREE.Raycaster();
    // Only meshes that opt into the shared interaction layer run geometry
    // raycasts; recursive traversal can then safely include the whole scene.
    this.raycaster.layers.set(INTERACTION_LAYER);
    this.pointer = new THREE.Vector2();
    this.desktopDrag = null;
    this.xrGrabs = new Map();
    this.xrControllers = [];
    this.xrControllerPoses = [];
    this.xrHands = [];
    this.xrRays = [];
    this.xrListeners = [];
    this.xrRayGeometry = null;
    this.lastFocusedTarget = null;
    this.hoveredDrawTarget = null;
    this.nextGestureId = 1;
    this.scratchQuaternion = new THREE.Quaternion();
    this.scratchParentQuaternion = new THREE.Quaternion();
    this.scratchEuler = new THREE.Euler();
    this.scratchPosition = new THREE.Vector3();
    this.scratchMovement = new THREE.Vector3();
    this.scratchScale = new THREE.Vector3();
    this.#bindDesktop();
    this.#bindXr();
  }

  #bindDesktop() {
    this.onPointerDown = (event) => {
      const hit = this.#desktopHit(event);
      if (!hit) return;
      event.stopImmediatePropagation();
      const drawTarget = this.#drawTarget(hit);
      if (drawTarget) {
        this.#draw(drawTarget, "start", hit);
        this.desktopDrag = { drawTarget, lastHit: hit, drawing: true };
        this.canvas.setPointerCapture(event.pointerId);
        return;
      }
      const target = this.#gestureTarget(hit);
      if (target) this.#focus(target);
      this.desktopDrag = {
        hit,
        target,
        start: new THREE.Vector2(event.clientX, event.clientY),
        last: new THREE.Vector2(event.clientX, event.clientY),
        moved: false,
      };
      this.canvas.setPointerCapture(event.pointerId);
    };
    this.onPointerMove = (event) => {
      if (!this.desktopDrag) {
        const hit = this.#desktopHit(event);
        this.#updateDrawHover(hit);
        const target = this.#gestureTarget(hit);
        if (target) this.#focus(target);
        return;
      }
      event.stopImmediatePropagation();
      if (this.desktopDrag.drawing) {
        const hit = this.#desktopHit(event);
        const target = this.#drawTarget(hit);
        if (target === this.desktopDrag.drawTarget) {
          this.desktopDrag.lastHit = hit;
          this.#updateDrawHover(hit);
          this.#draw(target, "update", hit);
        } else {
          this.#updateDrawHover(null);
        }
        return;
      }
      const current = new THREE.Vector2(event.clientX, event.clientY);
      const delta = current.clone().sub(this.desktopDrag.last);
      this.desktopDrag.last.copy(current);
      if (current.distanceTo(this.desktopDrag.start) > 5) {
        this.desktopDrag.moved = true;
      }
      if (this.desktopDrag.moved && this.desktopDrag.target) {
        this.onGesture?.(this.desktopDrag.target, {
          hands: 1,
          translation: { x: delta.x * 0.0025, y: -delta.y * 0.0025, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        });
      }
    };
    this.onPointerLeave = () => {
      if (!this.desktopDrag) this.#updateDrawHover(null);
    };
    this.onPointerUp = (event) => {
      if (!this.desktopDrag) return;
      event.stopImmediatePropagation();
      if (this.desktopDrag.drawing) {
        this.#draw(this.desktopDrag.drawTarget, "end", this.desktopDrag.lastHit);
      } else if (!this.desktopDrag.moved) {
        this.onActivate?.(this.desktopDrag.hit, { source: "desktop-pointer" });
      }
      this.desktopDrag = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
    };
    this.onPointerCancel = (event) => this.onPointerUp(event);
    this.onWheel = (event) => {
      const hit = this.#desktopHit(event);
      const target = this.#gestureTarget(hit);
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#focus(target);
      this.onGesture?.(target, {
        hands: 2,
        scale: Math.exp(-event.deltaY * 0.001),
      });
    };
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerCancel);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  #bindXr() {
    this.xrRayGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);
    for (let index = 0; index < 2; index += 1) {
      const controller = this.renderer.xr.getController(index);
      const ray = new THREE.Line(
        this.xrRayGeometry,
        new THREE.LineBasicMaterial({ color: 0xa1f0bd }),
      );
      ray.scale.z = 3;
      controller.add(ray);
      const onSelectStart = () => this.#xrSelectStart(index);
      const onSelectEnd = () => this.#xrSelectEnd(index);
      controller.addEventListener("selectstart", onSelectStart);
      controller.addEventListener("selectend", onSelectEnd);
      this.scene.add(controller);
      this.xrControllers.push(controller);
      this.xrControllerPoses.push({
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
      });
      this.xrRays.push(ray);
      this.xrListeners.push({ controller, onSelectStart, onSelectEnd });

      const hand = this.renderer.xr.getHand(index);
      this.scene.add(hand);
      this.xrHands.push(hand);
    }
  }

  #desktopHit(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.#firstInteractiveHit();
  }

  #xrSelectStart(index) {
    const controller = this.xrControllers[index];
    const ray = snapshotXrControllerRay(this.raycaster, controller);
    if (!ray) return;
    const hit = this.#firstInteractiveHit();
    if (!hit) return;
    const drawTarget = this.#drawTarget(hit);
    if (drawTarget) {
      this.#draw(drawTarget, "start", hit);
      this.xrGrabs.set(index, { drawTarget, lastHit: hit, drawing: true });
      return;
    }
    const gesture = this.#gestureTargetInfo(hit);
    const { target, root } = gesture;
    if (!target) {
      this.onActivate?.(hit, { source: "xr-select-start" });
      return;
    }
    this.#focus(target);
    const { position, quaternion } = this.#sampleControllerPose(index);
    const rayDrag = this.#canRayDrag(target, root)
      ? this.#captureRayDrag(hit, root, quaternion, ray)
      : null;
    const grab = {
      hit,
      target,
      root,
      rayDrag,
      startPosition: position.clone(),
      startQuaternion: quaternion.clone(),
      lastPosition: position.clone(),
      lastQuaternion: quaternion.clone(),
    };
    this.xrGrabs.set(index, grab);
    this.#startTwoHandGesture();
  }

  #xrSelectEnd(index) {
    const grab = this.xrGrabs.get(index);
    if (!grab) return;
    if (grab.drawing) {
      this.#draw(grab.drawTarget, "end", grab.lastHit);
      this.xrGrabs.delete(index);
      return;
    }
    const controller = this.xrControllers[index];
    if (!controller) {
      this.xrGrabs.delete(index);
      return;
    }
    const { position, quaternion } = this.#sampleControllerPose(index);
    const moved = grab.startPosition.distanceTo(position) > 0.015
      || 1 - Math.abs(grab.startQuaternion.dot(quaternion)) > 0.0001;
    if (!moved && !grab.gestureConsumed) this.onActivate?.(grab.hit, { source: "xr-select" });
    this.xrGrabs.delete(index);
    if (this.xrGrabs.size === 1) {
      this.#rebaseRemainingRayGrab();
    }
  }

  update() {
    if (!this.renderer.xr.isPresenting) return;
    if (this.xrGrabs.size === 0) {
      let hovered = false;
      for (const controller of this.xrControllers) {
        if (!setXrControllerRay(this.raycaster, controller)) continue;
        const hit = this.#firstInteractiveHit();
        if (this.#drawTarget(hit)) {
          this.#updateDrawHover(hit);
          hovered = true;
          break;
        }
        const target = this.#gestureTarget(hit);
        if (target) {
          this.#focus(target);
          break;
        }
      }
      if (!hovered) this.#updateDrawHover(null);
      return;
    }
    let hasDrawingGrab = false;
    for (const grab of this.xrGrabs.values()) {
      if (grab.drawing) {
        hasDrawingGrab = true;
        break;
      }
    }
    if (hasDrawingGrab) {
      let hovered = false;
      for (const [index, grab] of this.xrGrabs) {
        if (!grab.drawing
          || !setXrControllerRay(this.raycaster, this.xrControllers[index])) continue;
        const hit = this.#firstInteractiveHit();
        if (this.#drawTarget(hit) === grab.drawTarget) {
          grab.lastHit = hit;
          this.#updateDrawHover(hit);
          hovered = true;
          this.#draw(grab.drawTarget, "update", hit);
        }
      }
      if (!hovered) this.#updateDrawHover(null);
      return;
    }
    this.#updateDrawHover(null);
    if (this.xrGrabs.size === 1) {
      const [index, grab] = this.xrGrabs.entries().next().value;
      if (grab.suspended) return;
      const controller = this.xrControllers[index];
      if (!controller) return;
      const { position, quaternion } = this.#sampleControllerPose(index);
      if (grab.rayDrag) {
        const unchanged = grab.startPosition.distanceTo(position) <= 1e-8
          && 1 - Math.abs(grab.startQuaternion.dot(quaternion)) <= 1e-12;
        grab.lastPosition.copy(position);
        grab.lastQuaternion.copy(quaternion);
        if (unchanged) return;
        if (!setXrControllerRay(this.raycaster, controller)) return;
        const pose = solveRayDragPose(grab.rayDrag, {
          rayOrigin: this.raycaster.ray.origin,
          rayDirection: this.raycaster.ray.direction,
          controllerQuaternion: quaternion,
        });
        this.onGesture?.(grab.target, {
          hands: 1,
          absolutePose: this.#worldPoseToParentLocal(grab.root, pose),
        });
        return;
      }
      const movement = this.scratchMovement.copy(position).sub(grab.lastPosition);
      grab.lastPosition.copy(position);
      const rotationDelta = this.scratchQuaternion
        .copy(grab.lastQuaternion)
        .invert()
        .premultiply(quaternion);
      const rotation = this.scratchEuler.setFromQuaternion(rotationDelta, "XYZ");
      grab.lastQuaternion.copy(quaternion);
      this.onGesture?.(grab.target, {
        hands: 1,
        translation: movement,
        rotation: { x: rotation.x, y: rotation.y, z: rotation.z },
      });
      return;
    }
    const grabEntries = this.xrGrabs.entries();
    const [leftIndex, left] = grabEntries.next().value;
    const [rightIndex, right] = grabEntries.next().value;
    if (left.target !== right.target || left.root !== right.root) return;
    if (left.twoHand?.state && left.twoHand === right.twoHand) {
      const pose = this.#solveTwoHandGesture(left.twoHand.state, leftIndex, rightIndex);
      if (!pose) return;
      left.gestureConsumed = true;
      right.gestureConsumed = true;
      const gesture = {
        hands: 2,
        gestureId: left.twoHand.gestureId,
        absolutePose: this.#worldPoseToParentLocal(left.root, pose),
        scaleFactor: pose.scaleFactor,
        absoluteObjectScale: this.#worldScaleToParentLocal(left.root, pose.targetScale),
      };
      const manipulation = left.root.userData.manipulation;
      if (manipulation?.type === "panel" && !left.root.userData.minimized) {
        const initial = left.twoHand.initialDimensions;
        if (initial && Number.isFinite(initial.width) && Number.isFinite(initial.height)) {
          gesture.absoluteDimensions = {
            width: initial.width * pose.scaleFactor,
            height: initial.height * pose.scaleFactor,
          };
        }
      }
      this.onGesture?.(left.target, gesture);
      return;
    }
    // A movable root only accepts an initialized absolute pair. Falling back to
    // incremental scaling here would make a failed capture jump unpredictably.
    if (this.#canRayDrag(left.target, left.root)) return;
    const leftController = this.xrControllers[leftIndex];
    const rightController = this.xrControllers[rightIndex];
    if (!leftController || !rightController) return;
    const leftPosition = this.#sampleControllerPose(leftIndex).position;
    const rightPosition = this.#sampleControllerPose(rightIndex).position;
    const previous = left.lastPosition.distanceTo(right.lastPosition);
    const current = leftPosition.distanceTo(rightPosition);
    left.lastPosition.copy(leftPosition);
    right.lastPosition.copy(rightPosition);
    if (previous > 0.001) {
      if (Math.abs(current - previous) > 1e-5) {
        left.gestureConsumed = true;
        right.gestureConsumed = true;
      }
      this.onGesture?.(left.target, { hands: 2, scale: current / previous });
    }
  }

  #firstInteractiveHit() {
    const targets = this.overlayScene
      ? [...this.overlayScene.children, ...this.scene.children]
      : this.scene.children;
    return this.raycaster
      .intersectObjects(targets, true)
      .find((hit) => {
        let current = hit.object;
        while (current) {
          if (!current.visible) return false;
          current = current.parent;
        }
        return hit.object.userData.interactive;
      });
  }

  #gestureTarget(hit) {
    return this.#gestureTargetInfo(hit).target;
  }

  #drawTarget(hit) {
    let current = hit?.object;
    while (current) {
      if (current.userData.drawTarget != null) return current.userData.drawTarget;
      current = current.parent;
    }
    return null;
  }

  #draw(target, phase, hit) {
    if (!target || !hit?.uv) return;
    target.onDraw?.(phase, hit.uv, hit);
  }

  #updateDrawHover(hit) {
    const target = this.#drawTarget(hit);
    if (target !== this.hoveredDrawTarget) {
      this.hoveredDrawTarget?.onLeave?.();
      this.hoveredDrawTarget = target;
    }
    if (target && hit?.uv) target.onHover?.(hit.uv, hit);
  }

  #gestureTargetInfo(hit) {
    let current = hit?.object;
    while (current) {
      const target = current.userData.gestureTarget;
      if (target === false) return { target: null, root: null };
      if (target != null) return { target, root: current };
      current = current.parent;
    }
    return { target: null, root: null };
  }

  #canRayDrag(target, root) {
    const manipulation = root?.userData.manipulation;
    if (!manipulation || !target) return false;
    if (manipulation.type === "browser") return true;
    if (manipulation.type === "toolbar") return true;
    if (manipulation.type !== "panel" || typeof target !== "string"
      || root.userData.panelId !== target || root.userData.maskEditing) return false;
    return Boolean(root.userData.minimized)
      || !root.userData.locked;
  }

  setRayVisible(visible) {
    const show = Boolean(visible);
    for (const ray of this.xrRays) ray.visible = show;
  }

  #captureRayDrag(hit, root, controllerQuaternion, ray, localAnchor) {
    root.updateWorldMatrix(true, false);
    const targetPosition = new THREE.Vector3();
    const targetQuaternion = new THREE.Quaternion();
    const targetScale = new THREE.Vector3();
    root.getWorldPosition(targetPosition);
    root.getWorldQuaternion(targetQuaternion);
    root.getWorldScale(targetScale);
    const anchor = localAnchor
      ? new THREE.Vector3(localAnchor.x, localAnchor.y, localAnchor.z)
      : root.worldToLocal(hit.point.clone());
    return createRayDragState({
      rayOrigin: ray.rayOrigin,
      rayDirection: ray.rayDirection,
      hitPoint: hit.point,
      targetPosition,
      targetQuaternion,
      targetScale,
      localAnchor: anchor,
      controllerQuaternion,
    });
  }

  #startTwoHandGesture() {
    if (this.xrGrabs.size !== 2) return;
    const [[firstIndex, first], [secondIndex, second]] = [...this.xrGrabs.entries()];
    if (first.drawing || second.drawing || first.target !== second.target || first.root !== second.root
      || !this.#canRayDrag(first.target, first.root)) return;
    const firstHit = this.#rootManipulationHit(firstIndex, first.root);
    const secondHit = this.#rootManipulationHit(secondIndex, second.root);
    if (!firstHit || !secondHit) return;
    if (firstHit.point.distanceToSquared(secondHit.point) <= Number.EPSILON) return;
    const state = this.#captureTwoHandState(first.root, firstHit, secondHit);
    const manipulation = first.root.userData.manipulation ?? {};
    const pair = {
      state,
      firstIndex,
      secondIndex,
      gestureId: `two-ray-${this.nextGestureId++}`,
      initialDimensions: manipulation.initialDimensions
        ? { ...manipulation.initialDimensions }
        : manipulation.dimensions
          ? { ...manipulation.dimensions }
          : null,
    };
    first.twoHand = pair;
    second.twoHand = pair;
    first.suspended = false;
    second.suspended = false;
  }

  #rootManipulationHit(index, root) {
    const ray = snapshotXrControllerRay(this.raycaster, this.xrControllers[index]);
    if (!ray) return null;
    const hit = this.raycaster.intersectObject(root, true).find((candidate) =>
      candidate.object.userData.interactive
      && this.#gestureTargetInfo(candidate).root === root,
    );
    if (!hit) return null;
    hit.rayOrigin = ray.rayOrigin;
    hit.rayDirection = ray.rayDirection;
    return hit;
  }

  #sampleControllerPose(index) {
    const controller = this.xrControllers[index];
    const pose = this.xrControllerPoses[index];
    controller.getWorldPosition(pose.position);
    controller.getWorldQuaternion(pose.quaternion);
    return pose;
  }

  #captureTwoHandState(root, firstHit, secondHit) {
    root.updateWorldMatrix(true, false);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    root.getWorldPosition(position);
    root.getWorldQuaternion(quaternion);
    root.getWorldScale(scale);
    const hand = (hit) => ({
      rayOrigin: hit.rayOrigin,
      rayDirection: hit.rayDirection,
      hitPoint: hit.point,
      localAnchor: root.worldToLocal(hit.point.clone()),
    });
    const first = hand(firstHit);
    const second = hand(secondHit);
    const manipulation = root.userData.manipulation ?? {};
    return createTwoHandRayDragState({
      first,
      second,
      targetPosition: position,
      targetQuaternion: quaternion,
      targetScale: scale,
      scaleLimits: this.#twoHandScaleLimits(manipulation, scale),
    });
  }

  #twoHandScaleLimits(manipulation, targetScale) {
    const limits = manipulation.scaleLimits ?? { min: 1, max: 1 };
    if (manipulation.type !== "browser" && manipulation.type !== "toolbar") return limits;
    const current = Math.abs(targetScale.x);
    if (!Number.isFinite(current) || current <= Number.EPSILON) return limits;
    return {
      min: limits.min / current,
      max: limits.max / current,
    };
  }

  #solveTwoHandGesture(state, firstIndex, secondIndex) {
    const first = snapshotXrControllerRay(this.raycaster, this.xrControllers[firstIndex]);
    const second = snapshotXrControllerRay(this.raycaster, this.xrControllers[secondIndex]);
    if (!first || !second) return null;
    try {
      return solveTwoHandRayDragPose(state, { first, second });
    } catch (error) {
      if (error instanceof RangeError) return null;
      throw error;
    }
  }

  #rebaseRemainingRayGrab() {
    const [index, grab] = this.xrGrabs.entries().next().value;
    if (!this.#canRayDrag(grab.target, grab.root)) return;
    const pair = grab.twoHand;
    if (!pair?.state) return;
    const controller = this.xrControllers[index];
    const ray = snapshotXrControllerRay(this.raycaster, controller);
    const hand = pair?.firstIndex === index
      ? pair.state.first
      : pair?.secondIndex === index
        ? pair.state.second
        : null;
    if (!controller || !ray || !hand) {
      grab.twoHand = null;
      grab.rayDrag = null;
      grab.suspended = true;
      return;
    }
    const { position, quaternion } = this.#sampleControllerPose(index);
    const hit = {
      point: ray.rayOrigin.clone().addScaledVector(ray.rayDirection, hand.distance),
    };
    grab.root.updateWorldMatrix(true, false);
    const localAnchor = grab.root.worldToLocal(hit.point.clone());
    grab.rayDrag = this.#captureRayDrag(
      hit,
      grab.root,
      quaternion,
      ray,
      localAnchor,
    );
    grab.twoHand = null;
    grab.startPosition.copy(position);
    grab.startQuaternion.copy(quaternion);
    grab.lastPosition.copy(position);
    grab.lastQuaternion.copy(quaternion);
    grab.suspended = false;
  }

  #worldPoseToParentLocal(root, pose) {
    const position = this.scratchPosition.set(
      pose.position.x,
      pose.position.y,
      pose.position.z,
    );
    const quaternion = this.scratchQuaternion.set(
      pose.quaternion.x,
      pose.quaternion.y,
      pose.quaternion.z,
      pose.quaternion.w,
    ).normalize();
    const parent = root?.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      parent.worldToLocal(position);
      const parentQuaternion = this.scratchParentQuaternion;
      parent.getWorldQuaternion(parentQuaternion);
      quaternion.premultiply(parentQuaternion.invert()).normalize();
    }
    const rotation = this.scratchEuler.setFromQuaternion(
      quaternion,
      root?.rotation.order ?? "XYZ",
    );
    return {
      position: { x: position.x, y: position.y, z: position.z },
      rotation: { x: rotation.x, y: rotation.y, z: rotation.z },
    };
  }

  #worldScaleToParentLocal(root, worldScale) {
    const value = Number.isFinite(worldScale?.x) ? worldScale.x : 1;
    const parent = root?.parent;
    if (!parent) return value;
    parent.updateWorldMatrix(true, false);
    const parentScale = this.scratchScale;
    parent.getWorldScale(parentScale);
    const divisor = Math.abs(parentScale.x);
    return Number.isFinite(divisor) && divisor > Number.EPSILON ? value / divisor : value;
  }

  #focus(target) {
    if (target === this.lastFocusedTarget) return;
    this.lastFocusedTarget = target;
    this.onFocus?.(target);
  }

  dispose() {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.#updateDrawHover(null);
    for (const { controller, onSelectStart, onSelectEnd } of this.xrListeners) {
      controller.removeEventListener("selectstart", onSelectStart);
      controller.removeEventListener("selectend", onSelectEnd);
    }
    for (const ray of this.xrRays) {
      ray.removeFromParent();
      ray.material.dispose();
    }
    this.xrRayGeometry?.dispose();
    for (const controller of this.xrControllers) controller.removeFromParent();
    for (const hand of this.xrHands) hand.removeFromParent();
    this.xrListeners = [];
    this.xrRays = [];
    this.xrControllers = [];
    this.xrControllerPoses = [];
    this.xrHands = [];
    this.xrGrabs.clear();
  }
}
