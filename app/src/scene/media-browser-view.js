import * as THREE from "three";

import {
  disposeObject,
  markInteractive,
  makeButton,
  makeCanvasTexture,
  makeLabelTexture,
  roundedRect,
} from "./canvas-ui.js";
import { TagMenu } from "./tag-menu.js";
import { matchesTagFilter, normalizeTagIds } from "../core/tags.js";
import {
  adjacentSubdirectory,
  constrainDirectory,
  isDirectoryVisible,
  normalizeDirectoryPath,
  parentDirectoryPath,
} from "../core/directory-navigation.js";
import { DirectoryMenu } from "./directory-menu.js";

const VIEW_MODES = ["names", "thumbnails", "large"];
const SORT_MODES = ["name", "mtime", "size", "random"];
const BROWSER_TEXTURE_RESOLUTION = 2;

function entryTexture(entry) {
  return makeCanvasTexture({
    width: 640,
    height: 160,
    resolutionScale: BROWSER_TEXTURE_RESOLUTION,
    draw(context, canvas) {
      roundedRect(context, 3, 3, canvas.width - 6, canvas.height - 6, 22);
      context.fillStyle = "#17211f";
      context.fill();
      context.strokeStyle = "#394a45";
      context.lineWidth = 3;
      context.stroke();
      context.fillStyle = "#e7f0ec";
      context.font = "600 34px system-ui, sans-serif";
      context.textAlign = "left";
      context.textBaseline = "middle";
      context.fillText("Media", 28, 48);
      context.fillStyle = "#eef5f2";
      context.font = "500 35px system-ui, sans-serif";
      context.fillText(entry.name, 28, 105, canvas.width - 56);
    },
  });
}

function backdropTexture(title) {
  return makeCanvasTexture({
    width: 1200,
    height: 800,
    resolutionScale: BROWSER_TEXTURE_RESOLUTION,
    draw(context, canvas) {
      roundedRect(context, 2, 2, canvas.width - 4, canvas.height - 4, 35);
      context.fillStyle = "#0d1514";
      context.fill();
      context.strokeStyle = "#53665f";
      context.lineWidth = 4;
      context.stroke();
      context.fillStyle = "#91a39c";
      context.font = "600 24px system-ui, sans-serif";
      context.letterSpacing = "2px";
      context.fillText("MEDIA BROWSER", 52, 54);
      context.fillStyle = "#f0f6f3";
      context.font = "600 40px system-ui, sans-serif";
      context.fillText(title || "Media home", 52, 105, canvas.width - 104);
    },
  });
}

export class MediaBrowserView extends THREE.Group {
  constructor({
    api,
    selectedDirectories = [],
    sortEntries,
    onSelect,
    onError,
    tagDefinitions = [],
    tagFilter = [],
    onTagFilterChange,
    onOpenTagFilter,
  }) {
    super();
    this.api = api;
    this.selectedDirectories = selectedDirectories;
    this.sortEntries = sortEntries;
    this.onSelect = onSelect;
    this.onError = onError;
    this.onTagFilterChange = onTagFilterChange;
    this.onOpenTagFilter = onOpenTagFilter;
    this.tagDefinitions = tagDefinitions;
    this.tagFilter = normalizeTagIds(tagFilter);
    this.userData.tagFilter = [...this.tagFilter];
    this.path = "";
    this.workingDirectory = "";
    this.workingSubdirectories = [];
    this.entries = [];
    this.rawEntries = [];
    this.navigationGeneration = 0;
    this.viewMode = "names";
    this.sortMode = "name";
    this.page = 0;
    this.selectMode = false;
    this.selectedIds = new Set();
    this.position.set(0, 1.35, -1.25);
    this.name = "media-browser";
    this.interactionTarget = {
      type: "media-browser",
      onGesture: (gesture) => this.applyGesture(gesture),
    };
    this.userData.gestureTarget = this.interactionTarget;
    this.userData.manipulation = {
      type: "browser",
      scalable: true,
      scaleLimits: { min: 0.5, max: 2.5 },
    };
    this.#buildFrame();
  }

  #buildFrame() {
    this.backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(1.12, 0.75),
      new THREE.MeshBasicMaterial({
        map: backdropTexture("Media home"),
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    this.backdrop.position.z = -0.012;
    markInteractive(this.backdrop);
    this.backdrop.userData.kind = "browser-surface";
    this.backdrop.userData.textureSize = this.backdrop.material.map.userData.canvasSize;
    this.add(this.backdrop);

    const controls = [
      ["Page -", "browser-page-prev"],
      ["Page +", "browser-page-next"],
      ["View", "browser-view"],
      ["Sort", "browser-sort"],
      ["Select", "browser-toggle-select-mode"],
      ["Filter Tags", "toggle-tag-filter"],
      ["Close", "browser-close"],
    ];
    this.controls = new THREE.Group();
    controls.forEach(([label, action], index) => {
      const button = makeButton(label, action, {
        width: 0.13,
        height: 0.06,
        textureResolutionScale: BROWSER_TEXTURE_RESOLUTION,
      });
      button.position.set(-0.45 + index * 0.15, 0.3, 0);
      button.userData.browser = this;
      button.userData.gestureTarget = false;
      this.controls.add(button);
    });
    this.add(this.controls);

    this.directoryControls = new THREE.Group();
    this.directoryControls.position.y = 0.225;
    this.add(this.directoryControls);
    const navigationControls = [
      ["Up", "browser-directory-up", -0.49, 0.1],
      ["Subdir ▾", "browser-toggle-subdirectories", 0.07, 0.19],
      ["<", "browser-subdirectory-prev", 0.23, 0.07],
      [".", "browser-directory-current", 0.32, 0.07],
      [">", "browser-subdirectory-next", 0.41, 0.07],
    ];
    this.navigationButtons = new Map();
    for (const [label, action, x, width] of navigationControls) {
      const button = makeButton(label, action, {
        width,
        height: 0.052,
        textureResolutionScale: BROWSER_TEXTURE_RESOLUTION,
      });
      button.position.set(x, 0, 0.005);
      button.userData.browser = this;
      button.userData.gestureTarget = false;
      this.directoryControls.add(button);
      this.navigationButtons.set(action, button);
    }
    this.directoryLabel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.38, 0.052),
      new THREE.MeshBasicMaterial({
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    this.directoryLabel.position.set(-0.245, 0, 0.004);
    this.directoryLabel.userData.gestureTarget = false;
    this.directoryControls.add(this.directoryLabel);

    this.directoryMenu = new DirectoryMenu(this);
    this.directoryMenu.position.set(0, -0.055, 0.08);
    this.add(this.directoryMenu);
    this.filterMenu = new TagMenu({
      title: "FILTER BY TAG",
      prefix: "filter",
      clearAction: "clear-tag-filter",
      onAction: (_action, tagIds) => this.#setTagFilterFromMenu(tagIds),
    });
    this.filterMenu.position.set(0, -0.62, 0.04);
    this.filterMenu.setDefinitions(this.tagDefinitions);
    this.filterMenu.setSelected(this.tagFilter);
    this.add(this.filterMenu);

    this.content = new THREE.Group();
    this.add(this.content);
  }

  async open(path = "") {
    await this.#setWorkingDirectory(constrainDirectory(path, this.selectedDirectories));
  }

  async handleAction(action) {
    if (action === "browser-close") {
      this.visible = false;
      return;
    }
    if (action === "browser-directory-up") {
      await this.#setWorkingDirectory(parentDirectoryPath(this.workingDirectory));
      return;
    }
    if (action === "browser-toggle-subdirectories") {
      this.filterMenu.visible = false;
      this.directoryMenu.toggle();
      return;
    }
    if (this.directoryMenu.handleAction(action)) return;
    if (action.startsWith("browser-enter-directory:")) {
      this.directoryMenu.close();
      await this.#setWorkingDirectory(action.slice("browser-enter-directory:".length));
      return;
    }
    if (action === "browser-directory-current") {
      await this.#showDirectory(this.workingDirectory);
      return;
    }
    if (action === "browser-subdirectory-prev" || action === "browser-subdirectory-next") {
      const next = adjacentSubdirectory(
        this.workingDirectory,
        this.path,
        this.workingSubdirectories,
        action.endsWith("prev") ? -1 : 1,
      );
      await this.#showDirectory(next);
      return;
    }
    if (action === "browser-page-prev") {
      this.page = Math.max(0, this.page - 1);
      this.#renderEntries();
      return;
    }
    if (action === "browser-page-next") {
      this.page = Math.min(this.#pageCount() - 1, this.page + 1);
      this.#renderEntries();
      return;
    }
    if (action === "browser-view") {
      const current = VIEW_MODES.indexOf(this.viewMode);
      this.viewMode = VIEW_MODES[(current + 1) % VIEW_MODES.length];
      this.page = 0;
      this.#renderEntries();
      return;
    }
    if (action === "browser-sort") {
      const current = SORT_MODES.indexOf(this.sortMode);
      this.sortMode = SORT_MODES[(current + 1) % SORT_MODES.length];
      this.page = 0;
      this.#renderEntries();
      return;
    }
    if (action === "browser-toggle-select-mode") {
      if (this.selectMode) {
        const selected = this.#sortedEntries().filter((entry) => this.selectedIds.has(entry.path));
        if (selected.length > 0) {
          this.onSelect?.(selected[0], {
            directory: this.path,
            sortMode: this.sortMode,
            viewMode: this.viewMode,
            entries: selected,
          });
        }
        this.selectedIds.clear();
      }
      this.selectMode = !this.selectMode;
      this.#renderEntries();
      return;
    }
    if (action === "toggle-tag-filter") {
      try {
        this.directoryMenu.close();
        const definitions = await this.onOpenTagFilter?.();
        if (definitions) this.setTagDefinitions(definitions);
        this.filterMenu.toggle();
      } catch (error) {
        this.onError?.(new Error(`Could not refresh tag definitions: ${error.message}`));
      }
    }
  }

  async #setWorkingDirectory(path) {
    const next = constrainDirectory(path, this.selectedDirectories);
    const generation = ++this.navigationGeneration;
    this.page = 0;
    this.selectedIds.clear();
    try {
      const payload = await this.api.directory(next, this.selectedDirectories);
      if (generation !== this.navigationGeneration) return;
      const normalized = this.#normalizeEntries(payload);
      this.workingDirectory = next;
      this.path = next;
      this.workingSubdirectories = normalized
        .filter((entry) => entry.kind === "directory")
        .sort((left, right) => left.name.localeCompare(right.name));
      this.directoryMenu.setEntries(this.workingSubdirectories);
      this.rawEntries = normalized.filter((entry) => entry.kind !== "directory");
      this.#finishDirectoryLoad();
    } catch (error) {
      if (generation === this.navigationGeneration) this.onError?.(error);
    }
  }

  async #showDirectory(path) {
    const next = normalizeDirectoryPath(path);
    const allowed = next === this.workingDirectory
      || this.workingSubdirectories.some((entry) => entry.path === next);
    if (!allowed) return;
    const generation = ++this.navigationGeneration;
    this.page = 0;
    this.selectedIds.clear();
    try {
      const payload = await this.api.directory(next, this.selectedDirectories);
      if (generation !== this.navigationGeneration) return;
      this.path = next;
      this.rawEntries = this.#normalizeEntries(payload)
        .filter((entry) => entry.kind !== "directory");
      this.#finishDirectoryLoad();
    } catch (error) {
      if (generation === this.navigationGeneration) this.onError?.(error);
    }
  }

  #normalizeEntries(payload) {
    const rawEntries = payload.entries ?? payload.items ?? payload;
    return rawEntries
      .map((entry) => ({
        ...entry,
        path: entry.path ?? entry.relative_path,
        mediaType: entry.media_type ?? entry.type,
      }))
      .filter((entry) => isDirectoryVisible(entry.path, this.selectedDirectories));
  }

  #finishDirectoryLoad() {
    this.#applyTagFilter();
    this.#renderEntries();
    this.visible = true;
  }

  setTagDefinitions(definitions) {
    this.tagDefinitions = Array.isArray(definitions) ? definitions : [];
    this.filterMenu.setDefinitions(this.tagDefinitions);
  }

  setTagFilter(tagFilter) {
    const nextFilter = normalizeTagIds(tagFilter);
    if (this.tagFilter.length === nextFilter.length
      && this.tagFilter.every((tagId, index) => tagId === nextFilter[index])) {
      return false;
    }
    this.tagFilter = nextFilter;
    this.userData.tagFilter = [...this.tagFilter];
    this.filterMenu.setSelected(this.tagFilter);
    this.#applyTagFilter();
    this.#renderEntries();
    return true;
  }

  updateEntryTags(path, tagIds) {
    for (const entry of this.rawEntries) {
      if (entry.path === path) entry.tag_ids = normalizeTagIds(tagIds);
    }
    this.#applyTagFilter();
    this.#renderEntries();
  }

  async #setTagFilterFromMenu(tagIds) {
    this.setTagFilter(tagIds);
    await this.onTagFilterChange?.(this.tagFilter);
  }

  #applyTagFilter() {
    this.entries = this.rawEntries.filter((entry) => matchesTagFilter(entry, this.tagFilter));
  }

  async activateEntry(entry) {
    if (entry.kind === "directory") {
      await this.#setWorkingDirectory(entry.path);
      return;
    }
    if (this.selectMode) {
      if (this.selectedIds.has(entry.path)) this.selectedIds.delete(entry.path);
      else this.selectedIds.add(entry.path);
      this.#renderEntries();
      return;
    }
    this.onSelect?.(entry, {
      directory: this.path,
      sortMode: this.sortMode,
      viewMode: this.viewMode,
      entries: this.#sortedEntries(),
    });
  }

  applyGesture(gesture) {
    if (gesture?.absolutePose) {
      const position = gesture.absolutePose.position ?? {};
      const rotation = gesture.absolutePose.rotation ?? {};
      if ([position.x, position.y, position.z].every(Number.isFinite)) {
        this.position.set(position.x, position.y, position.z);
      }
      if ([rotation.x, rotation.y, rotation.z].every(Number.isFinite)) {
        this.rotation.set(rotation.x, rotation.y, rotation.z);
      }
      const requestedScale = gesture.absoluteObjectScale ?? gesture.scaleFactor;
      const value = typeof requestedScale === "number"
        ? requestedScale
        : requestedScale?.x;
      if (Number.isFinite(value)) {
        this.scale.setScalar(Math.min(2.5, Math.max(0.5, value)));
      }
      return;
    }
    if (gesture?.hands !== 1) return;
    const translation = gesture.translation ?? {};
    const rotation = gesture.rotation ?? {};
    this.position.x += Number.isFinite(translation.x) ? translation.x : 0;
    this.position.y += Number.isFinite(translation.y) ? translation.y : 0;
    this.position.z += Number.isFinite(translation.z) ? translation.z : 0;
    this.rotation.x += Number.isFinite(rotation.x) ? rotation.x : 0;
    this.rotation.y += Number.isFinite(rotation.y) ? rotation.y : 0;
    this.rotation.z += Number.isFinite(rotation.z) ? rotation.z : 0;
  }

  #sortedEntries() {
    if (this.sortEntries) {
      return this.sortEntries(this.entries, this.sortMode);
    }
    return [...this.entries].sort((a, b) => a.name.localeCompare(b.name));
  }

  #pageSize() {
    return this.viewMode === "names" ? 7 : this.viewMode === "large" ? 4 : 9;
  }

  #pageCount() {
    return Math.max(1, Math.ceil(this.entries.length / this.#pageSize()));
  }

  #renderEntries() {
    disposeObject(this.content);
    this.remove(this.content);
    this.content = new THREE.Group();
    this.add(this.content);

    const entries = this.#sortedEntries();
    const columns = this.viewMode === "names" ? 1 : this.viewMode === "large" ? 2 : 3;
    const maxItems = this.#pageSize();
    const cardWidth = columns === 1 ? 0.94 : columns === 2 ? 0.455 : 0.295;
    const cardHeight = this.viewMode === "names" ? 0.062 : this.viewMode === "large" ? 0.2 : 0.125;
    const startY = 0.145;

    const pageCount = this.#pageCount();
    this.page = Math.min(this.page, pageCount - 1);
    const visibleEntries = entries.slice(
      this.page * maxItems,
      (this.page + 1) * maxItems,
    );
    if (entries.length === 0) {
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(0.82, 0.07),
        new THREE.MeshBasicMaterial({
          map: makeLabelTexture("No matching media — clear Filter Tags", {
            width: 800,
            height: 100,
            font: "600 27px system-ui, sans-serif",
            resolutionScale: BROWSER_TEXTURE_RESOLUTION,
          }),
          transparent: true,
          side: THREE.DoubleSide,
        }),
      );
      label.position.set(0, 0.02, 0.002);
      label.userData.gestureTarget = false;
      this.content.add(label);
    }
    for (const [index, entry] of visibleEntries.entries()) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const card = new THREE.Mesh(
        new THREE.PlaneGeometry(cardWidth, cardHeight),
        new THREE.MeshBasicMaterial({
          map: entryTexture(entry),
          transparent: true,
          side: THREE.DoubleSide,
        }),
      );
      card.position.set(
        -0.47 + cardWidth / 2 + column * (cardWidth + 0.015),
        startY - cardHeight / 2 - row * (cardHeight + 0.012),
        0,
      );
      markInteractive(card);
      card.userData.kind = "browser-entry";
      card.userData.entry = entry;
      card.userData.browser = this;
      card.userData.gestureTarget = false;
      card.userData.textureSize = card.material.map.userData.canvasSize;
      this.content.add(card);
      if (this.selectMode) {
        const selected = this.selectedIds.has(entry.path);
        const mark = new THREE.Mesh(
          new THREE.PlaneGeometry(0.08, 0.034),
          new THREE.MeshBasicMaterial({
            map: makeLabelTexture(selected ? "☑" : "☐", {
              width: 160,
              height: 80,
              font: "700 40px system-ui, sans-serif",
              background: "rgba(10, 18, 16, 0.84)",
              border: "rgba(96, 221, 143, 0.8)",
              resolutionScale: BROWSER_TEXTURE_RESOLUTION,
            }),
            transparent: true,
            side: THREE.DoubleSide,
          }),
        );
        mark.position.set(cardWidth * 0.33, cardHeight * 0.37, 0.004);
        mark.userData.gestureTarget = false;
        card.add(mark);
      }

      if (this.viewMode !== "names") {
        card.material.map.dispose();
        const thumbnail = new THREE.TextureLoader().load(
          entry.thumbnail_url ?? this.api.thumbnailUrl(entry.path),
          undefined,
          undefined,
          () => {},
        );
        thumbnail.colorSpace = THREE.SRGBColorSpace;
        card.material.map = thumbnail;
        card.material.needsUpdate = true;
        const label = new THREE.Mesh(
          new THREE.PlaneGeometry(cardWidth * 0.94, 0.038),
          new THREE.MeshBasicMaterial({
            map: makeLabelTexture(entry.name, {
              width: 600,
              height: 90,
              font: "500 28px system-ui, sans-serif",
              background: "rgba(12, 19, 18, 0.92)",
              border: "rgba(86, 108, 100, 0.7)",
              resolutionScale: BROWSER_TEXTURE_RESOLUTION,
            }),
            transparent: true,
          }),
        );
        label.userData.textureSize = label.material.map.userData.canvasSize;
        label.position.set(0, -cardHeight * 0.36, 0.003);
        card.add(label);
      }
    }

    const previousMap = this.backdrop.material.map;
    const selectLabel = this.selectMode ? ` · select ${this.selectedIds.size}` : "";
    this.backdrop.material.map = backdropTexture(
      `${this.path || "Media home"} · ${this.viewMode} · ${this.sortMode}${selectLabel} · ${this.tagFilter.length ? `${this.tagFilter.length} tags · ` : ""}${this.page + 1}/${pageCount}`,
    );
    this.backdrop.material.needsUpdate = true;
    this.backdrop.userData.textureSize = this.backdrop.material.map.userData.canvasSize;
    previousMap.dispose();
    const previousDirectoryMap = this.directoryLabel.material.map;
    const cwd = this.workingDirectory || "Media home";
    const viewing = this.path === this.workingDirectory
      ? `CWD  ${cwd}`
      : `CWD  ${cwd}  ·  ${this.path.split("/").at(-1)}`;
    this.directoryLabel.material.map = makeLabelTexture(viewing, {
      width: 900,
      height: 120,
      align: "left",
      padding: 24,
      font: "600 27px system-ui, sans-serif",
      resolutionScale: BROWSER_TEXTURE_RESOLUTION,
    });
    this.directoryLabel.material.needsUpdate = true;
    previousDirectoryMap?.dispose();
    const hasSubdirectories = this.workingSubdirectories.length > 0;
    this.navigationButtons.get("browser-directory-up").material.color.set(
      this.workingDirectory ? 0xffffff : 0x66736f,
    );
    for (const action of [
      "browser-toggle-subdirectories",
      "browser-subdirectory-prev",
      "browser-subdirectory-next",
    ]) {
      this.navigationButtons.get(action).material.color.set(
        hasSubdirectories ? 0xffffff : 0x66736f,
      );
    }
    this.navigationButtons.get("browser-directory-current").material.color.set(
      this.path === this.workingDirectory ? 0xaaf1c3 : 0xffffff,
    );
  }

  dispose() {
    disposeObject(this);
  }
}
