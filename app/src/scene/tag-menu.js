import * as THREE from "three";

import {
  disposeObject,
  makeButton,
  makeCanvasTexture,
  roundedRect,
} from "./canvas-ui.js";
import {
  normalizeTagDefinitions,
  normalizeTagIds,
} from "../core/tags.js";

const RESOLUTION = 2;
const PAGE_SIZE = 6;

function titleTexture(title, page, count) {
  return makeCanvasTexture({
    width: 900,
    height: 140,
    resolutionScale: RESOLUTION,
    draw(context, canvas) {
      roundedRect(context, 2, 2, canvas.width - 4, canvas.height - 4, 24);
      context.fillStyle = "#0d1514";
      context.fill();
      context.strokeStyle = "#53665f";
      context.lineWidth = 3;
      context.stroke();
      context.fillStyle = "#eaf3ef";
      context.font = "700 34px system-ui, sans-serif";
      context.textAlign = "left";
      context.textBaseline = "middle";
      context.fillText(title, 28, 70, canvas.width - 140);
      context.fillStyle = "#91a39c";
      context.font = "600 22px system-ui, sans-serif";
      context.textAlign = "right";
      context.fillText(`${page}/${count}`, canvas.width - 28, 70);
    },
  });
}

export class TagMenu extends THREE.Group {
  constructor({ title, prefix, clearAction = null, onAction } = {}) {
    super();
    this.title = title;
    this.prefix = prefix;
    this.clearAction = clearAction;
    this.onAction = onAction;
    this.definitions = [];
    this.selectedTagIds = [];
    this.actionPending = false;
    this.page = 0;
    this.name = `${prefix}-tag-menu`;
    this.userData.tagMenu = this;
    this.userData.title = title;
    this.userData.selectedTagIds = this.selectedTagIds;
    this.visible = false;
    this.#render();
  }

  setDefinitions(definitions) {
    const nextDefinitions = normalizeTagDefinitions(definitions);
    const unchanged = nextDefinitions.length === this.definitions.length
      && nextDefinitions.every((definition, index) =>
        definition.id === this.definitions[index].id && definition.name === this.definitions[index].name);
    this.definitions = nextDefinitions;
    const known = new Set(this.definitions.map((definition) => definition.id));
    const nextSelected = this.selectedTagIds.filter((id) => known.has(id));
    const selectionChanged = nextSelected.length !== this.selectedTagIds.length;
    this.selectedTagIds = nextSelected;
    this.page = Math.min(this.page, this.#pageCount() - 1);
    if (!unchanged || selectionChanged) this.#render();
  }

  setSelected(tagIds) {
    const nextSelected = normalizeTagIds(tagIds);
    if (nextSelected.length === this.selectedTagIds.length
      && nextSelected.every((id, index) => id === this.selectedTagIds[index])) return;
    this.selectedTagIds = nextSelected;
    this.userData.selectedTagIds = [...this.selectedTagIds];
    this.#render();
  }

  toggle() {
    this.visible = !this.visible;
    return this.visible;
  }

  async handleAction(action) {
    if (action === `${this.prefix}-prev`) {
      this.page = Math.max(0, this.page - 1);
      this.#render();
      return;
    }
    if (action === `${this.prefix}-next`) {
      this.page = Math.min(this.#pageCount() - 1, this.page + 1);
      this.#render();
      return;
    }
    if (action === `${this.prefix}-close`) {
      this.visible = false;
      return;
    }
    if (action === this.clearAction) {
      await this.#commitSelection(action, []);
      return;
    }
    const actionPrefix = `toggle-${this.prefix}-tag:`;
    if (action.startsWith(actionPrefix)) {
      const id = action.slice(actionPrefix.length);
      const next = this.selectedTagIds.includes(id)
        ? this.selectedTagIds.filter((tagId) => tagId !== id)
        : [...this.selectedTagIds, id];
      await this.#commitSelection(action, next, id);
    }
  }

  async #commitSelection(action, next, id) {
    if (this.actionPending) return;
    const previous = [...this.selectedTagIds];
    this.actionPending = true;
    this.setSelected(next);
    try {
      await this.onAction?.(action, next, id);
    } catch (error) {
      this.setSelected(previous);
      throw error;
    } finally {
      this.actionPending = false;
      this.#render();
    }
  }

  #pageCount() {
    return Math.max(1, Math.ceil(this.definitions.length / PAGE_SIZE));
  }

  #button(label, action, x, y, { active = false } = {}) {
    const button = makeButton(label, action, {
      width: 0.29,
      height: 0.052,
      textureWidth: 600,
      textureResolutionScale: RESOLUTION,
      background: active ? "#294c38" : "#17211f",
      border: active ? "#8ce8af" : "#40534d",
    });
    button.position.set(x, y, 0.008);
    button.userData.gestureTarget = false;
    button.userData.tagMenu = this;
    button.userData.selected = active;
    button.userData.pending = this.actionPending;
    return button;
  }

  #render() {
    disposeObject(this);
    this.clear();
    const pageCount = this.#pageCount();
    this.page = Math.min(this.page, pageCount - 1);
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(0.7, 0.56),
      new THREE.MeshBasicMaterial({
        map: titleTexture(this.title, this.page + 1, pageCount),
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    backdrop.position.z = -0.01;
    backdrop.userData.gestureTarget = false;
    this.add(backdrop);
    const pageDefinitions = this.definitions.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE);
    pageDefinitions.forEach((definition, index) => {
      const selected = this.selectedTagIds.includes(definition.id);
      const button = this.#button(
        `${selected ? "✓ " : ""}${definition.name}`,
        `toggle-${this.prefix}-tag:${definition.id}`,
        index % 2 ? 0.175 : -0.175,
        0.16 - Math.floor(index / 2) * 0.075,
        { active: selected },
      );
      button.userData.tagId = definition.id;
      this.add(button);
    });
    this.add(this.#button("Prev", `${this.prefix}-prev`, -0.235, -0.22));
    this.add(this.#button("Next", `${this.prefix}-next`, 0.075, -0.22));
    if (this.clearAction) this.add(this.#button("Clear", this.clearAction, -0.175, -0.29));
    this.add(this.#button("Close", `${this.prefix}-close`, this.clearAction ? 0.175 : 0, -0.29));
    this.userData.selectedTagIds = [...this.selectedTagIds];
  }
}
