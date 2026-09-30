import * as THREE from "three";

import { markInteractive } from "../canvas-ui.js";

import { optionsWidth } from "./constants.js";

/**
 * Adds the backdrop behind all option controls. The surrounding group owns the
 * gesture target, so the whole window drags from anywhere inside the backdrop.
 */
export function addBackdrop(content, { height, centerY }, { expandedTags }) {
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(optionsWidth(expandedTags), height),
    new THREE.MeshBasicMaterial({
      color: 0x101817,
      transparent: true,
      opacity: 0.96,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  backdrop.position.set(0, centerY, -0.01);
  backdrop.userData.kind = "options-surface";
  markInteractive(backdrop);
  content.add(backdrop);
  backdrop.renderOrder = -1;
}
