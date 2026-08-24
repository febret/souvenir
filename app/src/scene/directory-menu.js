import * as THREE from "three";

import {
  disposeObject,
  makeButton,
  makeCanvasTexture,
  roundedRect,
} from "./canvas-ui.js";

const PAGE_SIZE = 6;
const RESOLUTION = 2;

function menuTexture(page, pageCount) {
  return makeCanvasTexture({
    width: 900,
    height: 560,
    resolutionScale: RESOLUTION,
    draw(context, canvas) {
      roundedRect(context, 2, 2, canvas.width - 4, canvas.height - 4, 28);
      context.fillStyle = "#0d1514";
      context.fill();
      context.strokeStyle = "#53665f";
      context.lineWidth = 4;
      context.stroke();
      context.fillStyle = "#eaf3ef";
      context.font = "700 34px system-ui, sans-serif";
      context.textBaseline = "middle";
      context.fillText("SUBDIRECTORIES", 34, 54);
      context.fillStyle = "#91a39c";
      context.font = "600 23px system-ui, sans-serif";
      context.textAlign = "right";
      context.fillText(`${page}/${pageCount}`, canvas.width - 34, 54);
    },
  });
}

export class DirectoryMenu extends THREE.Group {
  constructor(browser) {
    super();
    this.browser = browser;
    this.entries = [];
    this.page = 0;
    this.visible = false;
    this.name = "browser-directory-menu";
    this.#render();
  }

  setEntries(entries) {
    this.entries = (Array.isArray(entries) ? entries : [])
      .map((entry) => ({ ...entry }))
      .sort((left, right) => left.name.localeCompare(right.name));
    this.page = Math.min(this.page, this.#pageCount() - 1);
    this.#render();
  }

  toggle() {
    if (!this.entries.length) {
      this.visible = false;
      return false;
    }
    this.visible = !this.visible;
    return this.visible;
  }

  close() {
    this.visible = false;
  }

  handleAction(action) {
    if (action === "browser-directory-menu-prev") {
      this.page = Math.max(0, this.page - 1);
      this.#render();
      return true;
    }
    if (action === "browser-directory-menu-next") {
      this.page = Math.min(this.#pageCount() - 1, this.page + 1);
      this.#render();
      return true;
    }
    if (action === "browser-directory-menu-close") {
      this.close();
      return true;
    }
    return false;
  }

  #pageCount() {
    return Math.max(1, Math.ceil(this.entries.length / PAGE_SIZE));
  }

  #button(label, action, x, y, width = 0.28) {
    const button = makeButton(label, action, {
      width,
      height: 0.052,
      textureWidth: 680,
      textureResolutionScale: RESOLUTION,
    });
    button.position.set(x, y, 0.012);
    button.userData.browser = this.browser;
    button.userData.gestureTarget = false;
    return button;
  }

  #render() {
    const wasVisible = this.visible;
    disposeObject(this);
    this.clear();
    const pageCount = this.#pageCount();
    this.page = Math.min(this.page, pageCount - 1);
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(0.66, 0.47),
      new THREE.MeshBasicMaterial({
        map: menuTexture(this.page + 1, pageCount),
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    backdrop.position.z = -0.01;
    backdrop.userData.interactive = true;
    backdrop.userData.kind = "browser-menu-background";
    backdrop.userData.gestureTarget = false;
    this.add(backdrop);

    this.entries
      .slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE)
      .forEach((entry, index) => {
        const button = this.#button(
          entry.name,
          `browser-enter-directory:${entry.path}`,
          index % 2 ? 0.16 : -0.16,
          0.13 - Math.floor(index / 2) * 0.07,
        );
        button.userData.directoryPath = entry.path;
        this.add(button);
      });
    this.add(this.#button("Prev", "browser-directory-menu-prev", -0.22, -0.17, 0.18));
    this.add(this.#button("Next", "browser-directory-menu-next", 0, -0.17, 0.18));
    this.add(this.#button("Close", "browser-directory-menu-close", 0.22, -0.17, 0.18));
    this.visible = wasVisible;
  }
}
