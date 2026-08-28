import * as THREE from "three";

import { markInteractive } from "../canvas-ui.js";

import { PANEL_WIDTH } from "./constants.js";

/**
 * Adds the draggable backdrop behind all option controls.
 */
export function addBackdrop(content, { height, centerY }, { dragTarget, expandedTags }) {
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_WIDTH + (expandedTags ? 0.58 : 0), height),
    new THREE.MeshBasicMaterial({
      color: 0x101817,
      transparent: true,
      opacity: 0.96,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  backdrop.position.set(0, centerY, -0.01);
  backdrop.userData.gestureTarget = dragTarget;
  markInteractive(backdrop);
  content.add(backdrop);
  backdrop.renderOrder = -1;
}
