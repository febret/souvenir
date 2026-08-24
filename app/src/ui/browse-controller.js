import {
  assignmentsAfterTagToggle,
  clampBrowseTransform,
  matchesTagCountFilter,
  tagSelectionState,
  updateBrowseSelection,
  zoomBrowseTransform,
} from "../core/browse.js";
import {
  constrainDirectory,
  normalizeDirectoryPath,
  parentDirectoryPath,
} from "../core/directory-navigation.js";
import { isImage, isVideo, normalizeMediaEntry, sortMedia } from "../core/media.js";
import { normalizeTagDefinitions, normalizeTagIds } from "../core/tags.js";
import {
  applyTagPillPreview,
  createTagPill,
  TagPreviewResolver,
} from "./tag-pill.js";

export class BrowseController {
  constructor(document, {
    api,
    selectedDirectories,
    tagDefinitions,
    onClose,
    onError,
  }) {
    this.document = document;
    this.api = api;
    this.selectedDirectories = selectedDirectories;
    this.tagDefinitions = tagDefinitions;
    this.onClose = onClose;
    this.onError = onError;
    this.path = "";
    this.entries = [];
    this.selectedIds = new Set();
    this.anchorIndex = null;
    this.loadingGeneration = 0;
    this.savingTags = false;
    this.viewerEntry = null;
    this.transform = { zoom: 1, x: 0, y: 0 };
    this.pointers = new Map();
    this.dragOrigin = null;
    this.pinchOrigin = null;
    this.tagPreviewResolver = new TagPreviewResolver({
      api: this.api,
      selectedDirectories: () => [...this.selectedDirectories()],
      onUpdate: (tagIds) => this.#refreshTagPillPreviews(tagIds),
    });
    this.elements = {
      shell: document.querySelector("#browse-shell"),
      titleBar: document.querySelector(".browse-title-bar"),
      toolbar: document.querySelector(".browse-toolbar"),
      workspace: document.querySelector(".browse-workspace"),
      exit: document.querySelector("#exit-browse"),
      breadcrumbs: document.querySelector("#browse-breadcrumbs"),
      sort: document.querySelector("#browse-sort"),
      typeFilter: document.querySelector("#browse-type-filter"),
      tagCountFilter: document.querySelector("#browse-tag-count-filter"),
      up: document.querySelector("#browse-up"),
      state: document.querySelector("#browse-state"),
      grid: document.querySelector("#browse-grid"),
      selectionStatus: document.querySelector("#browse-selection-status"),
      selectAll: document.querySelector("#browse-select-all"),
      tagHelp: document.querySelector("#browse-tags-help"),
      tagList: document.querySelector("#browse-tag-list"),
      tagError: document.querySelector("#browse-tag-error"),
      viewer: document.querySelector("#browse-viewer"),
      viewerTitle: document.querySelector("#browse-viewer-title"),
      viewerClose: document.querySelector("#browse-viewer-close"),
      viewerStage: document.querySelector("#browse-viewer-stage"),
      viewerImage: document.querySelector("#browse-viewer-image"),
      viewerVideo: document.querySelector("#browse-viewer-video"),
      imageControls: document.querySelector("#browse-image-controls"),
      zoomOut: document.querySelector("#browse-zoom-out"),
      zoomIn: document.querySelector("#browse-zoom-in"),
      zoomValue: document.querySelector("#browse-zoom-value"),
      fit: document.querySelector("#browse-fit"),
      previous: document.querySelector("#browse-viewer-prev"),
      next: document.querySelector("#browse-viewer-next"),
    };
    this.#bindEvents();
    this.viewerReturnFocus = null;
  }

  async open(path = "") {
    this.elements.shell.hidden = false;
    this.elements.shell.inert = false;
    await this.navigate(constrainDirectory(path, this.selectedDirectories()));
    this.elements.exit.focus();
  }

  close() {
    this.loadingGeneration += 1;
    this.closeViewer();
    this.selectedIds.clear();
    this.entries = [];
    this.elements.grid.replaceChildren();
    this.elements.shell.hidden = true;
    this.elements.shell.inert = true;
    this.onClose?.();
  }

  async navigate(path) {
    const next = constrainDirectory(path, this.selectedDirectories());
    const generation = ++this.loadingGeneration;
    this.path = next;
    this.selectedIds.clear();
    this.anchorIndex = null;
    this.elements.state.textContent = "Loading media…";
    this.elements.grid.setAttribute("aria-busy", "true");
    this.#renderBreadcrumbs();
    this.#renderSelection();
    try {
      const payload = await this.api.directory(next, this.selectedDirectories());
      if (generation !== this.loadingGeneration) return;
      const rawEntries = Array.isArray(payload)
        ? payload
        : payload?.entries ?? payload?.items ?? [];
      this.entries = rawEntries.map((entry) => {
        if (entry?.kind === "directory") {
          return {
            ...entry,
            path: normalizeDirectoryPath(entry.path),
            name: entry.name || normalizeDirectoryPath(entry.path).split("/").at(-1),
          };
        }
        return normalizeMediaEntry(entry);
      });
      this.#render();
    } catch (error) {
      if (generation !== this.loadingGeneration) return;
      this.entries = [];
      this.elements.grid.replaceChildren();
      this.elements.state.textContent = "Media could not be loaded.";
      this.onError?.(error);
    } finally {
      if (generation === this.loadingGeneration) {
        this.elements.grid.setAttribute("aria-busy", "false");
      }
    }
  }

  refreshTagDefinitions() {
    this.#renderTags();
  }

  #bindEvents() {
    this.elements.exit.addEventListener("click", () => this.close());
    this.elements.up.addEventListener("click", () =>
      this.navigate(parentDirectoryPath(this.path)));
    this.elements.sort.addEventListener("change", () => {
      this.anchorIndex = null;
      this.#render();
    });
    this.elements.typeFilter.addEventListener("change", () => {
      this.anchorIndex = null;
      this.#render();
    });
    this.elements.tagCountFilter.addEventListener("change", () => {
      this.anchorIndex = null;
      this.#render();
    });
    this.elements.selectAll.addEventListener("click", () => {
      const visible = this.#visibleMedia();
      const allSelected = visible.length > 0
        && visible.every((entry) => this.selectedIds.has(entry.path));
      this.selectedIds = allSelected
        ? new Set()
        : new Set(visible.map((entry) => entry.path));
      this.anchorIndex = null;
      this.#render();
    });
    this.elements.viewerClose.addEventListener("click", () => this.closeViewer());
    this.elements.previous.addEventListener("click", () => this.#stepViewer(-1));
    this.elements.next.addEventListener("click", () => this.#stepViewer(1));
    this.elements.zoomIn.addEventListener("click", () => this.#zoomBy(1.25));
    this.elements.zoomOut.addEventListener("click", () => this.#zoomBy(0.8));
    this.elements.fit.addEventListener("click", () => this.#resetTransform());
    this.elements.viewerStage.addEventListener("wheel", (event) => {
      if (!this.viewerEntry || !isImage(this.viewerEntry)) return;
      event.preventDefault();
      const bounds = this.elements.viewerStage.getBoundingClientRect();
      this.#setZoom(
        this.transform.zoom * (event.deltaY < 0 ? 1.15 : 0.87),
        { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 },
      );
    }, { passive: false });
    this.elements.viewerStage.addEventListener("pointerdown", (event) => this.#pointerDown(event));
    this.elements.viewerStage.addEventListener("pointermove", (event) => this.#pointerMove(event));
    this.elements.viewerStage.addEventListener("pointerup", (event) => this.#pointerUp(event));
    this.elements.viewerStage.addEventListener("pointercancel", (event) => this.#pointerUp(event));
    this.elements.viewerImage.addEventListener("load", () => this.#resetTransform());
    window.addEventListener("resize", () => {
      if (this.viewerEntry && isImage(this.viewerEntry)) this.#applyTransform();
    });
    window.addEventListener("keydown", (event) => {
      if (this.elements.shell.hidden) return;
      if (!this.elements.viewer.hidden) {
        if (event.key === "Tab") this.#trapViewerFocus(event);
        else if (event.key === "Escape") this.closeViewer();
        else if (event.key === "ArrowLeft") this.#stepViewer(-1);
        else if (event.key === "ArrowRight") this.#stepViewer(1);
        else if (event.key === "+" || event.key === "=") this.#zoomBy(1.25);
        else if (event.key === "-") this.#zoomBy(0.8);
        else if (event.key === "0") this.#resetTransform();
      } else if (event.key === "Escape") {
        this.close();
      }
    });
  }

  #visibleMedia() {
    const type = this.elements.typeFilter.value;
    const media = this.entries.filter((entry) =>
      entry.kind !== "directory"
      && (type === "all" || (type === "image" && isImage(entry)) || (type === "video" && isVideo(entry)))
      && matchesTagCountFilter(entry, this.elements.tagCountFilter.value));
    return sortMedia(media, { mode: this.elements.sort.value });
  }

  #visibleEntries() {
    const directories = this.entries
      .filter((entry) => entry.kind === "directory")
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    return [...directories, ...this.#visibleMedia()];
  }

  #render() {
    const entries = this.#visibleEntries();
    const visibleMedia = entries.filter((entry) => entry.kind !== "directory");
    const visibleIds = new Set(visibleMedia.map((entry) => entry.path));
    this.selectedIds = new Set([...this.selectedIds].filter((id) => visibleIds.has(id)));
    this.elements.grid.replaceChildren();
    entries.forEach((entry) => {
      if (entry.kind === "directory") this.elements.grid.append(this.#directoryCard(entry));
      else this.elements.grid.append(this.#mediaCard(entry, visibleMedia));
    });
    const mediaCount = visibleMedia.length;
    const folderCount = entries.length - mediaCount;
    this.elements.state.textContent = entries.length
      ? `${mediaCount} media item${mediaCount === 1 ? "" : "s"}${folderCount ? ` · ${folderCount} folder${folderCount === 1 ? "" : "s"}` : ""}`
      : "No matching media in this folder.";
    this.elements.up.disabled = !this.path;
    this.#renderBreadcrumbs();
    this.#renderSelection();
  }

  #directoryCard(entry) {
    const button = this.document.createElement("button");
    button.type = "button";
    button.className = "browse-card browse-folder";
    button.innerHTML = '<span class="browse-folder-icon" aria-hidden="true">▱</span>';
    const name = this.document.createElement("strong");
    name.textContent = entry.name;
    button.append(name);
    button.addEventListener("click", () => this.navigate(entry.path));
    return button;
  }

  #mediaCard(entry, visibleMedia) {
    const card = this.document.createElement("article");
    card.className = "browse-card browse-media";
    card.dataset.path = entry.path;
    card.classList.toggle("selected", this.selectedIds.has(entry.path));
    const select = this.document.createElement("button");
    select.type = "button";
    select.className = "browse-media-select";
    select.setAttribute("aria-pressed", String(this.selectedIds.has(entry.path)));
    select.setAttribute("aria-label", `Select ${entry.name}`);
    const thumbnail = this.document.createElement("img");
    thumbnail.src = this.api.thumbnailUrl(entry.path);
    thumbnail.alt = "";
    thumbnail.loading = "lazy";
    const type = this.document.createElement("span");
    type.className = "browse-type-badge";
    type.textContent = isVideo(entry) ? "VIDEO" : "IMAGE";
    const tagCount = normalizeTagIds(entry.tag_ids).length;
    const tagBadge = this.document.createElement("span");
    tagBadge.className = "browse-tag-count-badge";
    tagBadge.textContent = `${tagCount}`;
    tagBadge.setAttribute(
      "aria-label",
      `${tagCount} tag${tagCount === 1 ? "" : "s"} applied`,
    );
    tagBadge.title = `${tagCount} tag${tagCount === 1 ? "" : "s"} applied`;
    select.append(thumbnail, type, tagBadge);
    select.addEventListener("click", (event) => {
      const index = visibleMedia.findIndex((item) => item.path === entry.path);
      const result = updateBrowseSelection(this.selectedIds, visibleMedia.map((item) => item.path), index, {
        toggle: event.ctrlKey || event.metaKey,
        range: event.shiftKey,
        anchorIndex: this.anchorIndex,
      });
      this.selectedIds = result.selectedIds;
      this.anchorIndex = result.anchorIndex;
      this.#render();
    });
    select.addEventListener("dblclick", () => this.openViewer(entry));
    const footer = this.document.createElement("div");
    const name = this.document.createElement("strong");
    name.textContent = entry.name;
    name.title = entry.name;
    const preview = this.document.createElement("button");
    preview.type = "button";
    preview.className = "browse-preview-button";
    preview.textContent = "Preview";
    preview.addEventListener("click", () => this.openViewer(entry, preview));
    footer.append(name, preview);
    card.append(select, footer);
    return card;
  }

  #renderBreadcrumbs() {
    this.elements.breadcrumbs.replaceChildren();
    const home = this.#breadcrumbButton("Media home", "");
    this.elements.breadcrumbs.append(home);
    const parts = this.path.split("/").filter(Boolean);
    let path = "";
    parts.forEach((part) => {
      path = path ? `${path}/${part}` : part;
      const separator = this.document.createElement("span");
      separator.textContent = "/";
      separator.setAttribute("aria-hidden", "true");
      this.elements.breadcrumbs.append(separator, this.#breadcrumbButton(part, path));
    });
  }

  #breadcrumbButton(label, path) {
    const button = this.document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = normalizeDirectoryPath(path) === this.path;
    button.addEventListener("click", () => this.navigate(path));
    return button;
  }

  #selectedEntries() {
    return this.entries.filter((entry) =>
      entry.kind !== "directory" && this.selectedIds.has(entry.path));
  }

  #renderSelection() {
    const selected = this.#selectedEntries();
    this.elements.selectionStatus.textContent = selected.length
      ? `${selected.length} selected`
      : "No media selected";
    const visible = this.#visibleMedia();
    const allSelected = visible.length > 0
      && visible.every((entry) => this.selectedIds.has(entry.path));
    this.elements.selectAll.textContent = allSelected ? "Clear selection" : "Select all";
    this.elements.selectAll.disabled = visible.length === 0;
    this.#renderTags();
  }

  #renderTags() {
    const selected = this.#selectedEntries();
    const definitions = normalizeTagDefinitions(this.tagDefinitions());
    this.elements.tagList.replaceChildren();
    this.elements.tagList.disabled = !selected.length || this.savingTags;
    this.elements.tagHelp.textContent = selected.length
      ? `Changes apply to ${selected.length} selected item${selected.length === 1 ? "" : "s"}.`
      : "Select one or more files to edit their tags.";
    if (!definitions.length) {
      const empty = this.document.createElement("p");
      empty.textContent = "Create a shared tag on the portal first.";
      this.elements.tagList.append(empty);
      return;
    }
    this.tagPreviewResolver.ensure(definitions.map((tag) => tag.id));
    definitions.forEach((tag) => {
      const label = this.document.createElement("label");
      label.className = "browse-tag-option";
      const input = this.document.createElement("input");
      input.type = "checkbox";
      input.value = tag.id;
      const state = tagSelectionState(selected, tag.id);
      input.checked = state.checked;
      input.indeterminate = state.indeterminate;
      input.addEventListener("change", () => this.#saveTag(tag.id, input.checked));
      const text = createTagPill(this.document, {
        tagId: tag.id,
        label: tag.name,
        className: "tag-pill--compact",
      });
      applyTagPillPreview(text, this.tagPreviewResolver.previewFor(tag.id));
      label.append(input, text);
      this.elements.tagList.append(label);
    });
  }

  #refreshTagPillPreviews(tagIds = null) {
    const relevant = tagIds ? new Set(normalizeTagIds(tagIds)) : null;
    this.elements.tagList.querySelectorAll(".tag-pill[data-tag-id]").forEach((pill) => {
      if (relevant && !relevant.has(pill.dataset.tagId)) return;
      applyTagPillPreview(pill, this.tagPreviewResolver.previewFor(pill.dataset.tagId));
    });
  }

  async #saveTag(tagId, assigned) {
    const selected = this.#selectedEntries();
    if (!selected.length || this.savingTags) return;
    const assignments = assignmentsAfterTagToggle(selected, tagId, assigned);
    this.savingTags = true;
    this.elements.tagError.hidden = true;
    this.#renderTags();
    try {
      const response = await this.api.saveMediaTagsBulk(assignments);
      const savedAssignments = Array.isArray(response?.assignments)
        ? response.assignments
        : assignments;
      const saved = new Map(savedAssignments.map((item) => [
        item.path,
        normalizeTagIds(item.tag_ids),
      ]));
      this.entries.forEach((entry) => {
        if (saved.has(entry.path)) entry.tag_ids = saved.get(entry.path);
      });
      this.tagPreviewResolver.invalidate();
      this.#render();
    } catch (error) {
      this.elements.tagError.textContent =
        error instanceof Error ? error.message : "Could not save media tags.";
      this.elements.tagError.hidden = false;
      this.onError?.(error);
    } finally {
      this.savingTags = false;
      this.#renderTags();
    }
  }

  openViewer(entry, returnFocus = null) {
    if (this.elements.viewer.hidden) {
      this.viewerReturnFocus = returnFocus ?? this.document.activeElement;
    }
    this.viewerEntry = entry;
    this.elements.titleBar.inert = true;
    this.elements.breadcrumbs.inert = true;
    this.elements.toolbar.inert = true;
    this.elements.workspace.inert = true;
    this.elements.viewer.hidden = false;
    this.elements.viewerTitle.textContent = entry.name;
    const image = isImage(entry);
    this.elements.viewerImage.hidden = !image;
    this.elements.viewerVideo.hidden = image;
    this.elements.imageControls.hidden = !image;
    if (image) {
      this.elements.viewerVideo.pause();
      this.elements.viewerVideo.removeAttribute("src");
      this.elements.viewerImage.src = this.api.fileUrl(entry.path);
      this.elements.viewerImage.alt = entry.name;
    } else {
      this.elements.viewerImage.removeAttribute("src");
      this.elements.viewerVideo.src = this.api.fileUrl(entry.path);
    }
    this.#updateViewerNavigation();
    this.elements.viewerClose.focus();
  }

  closeViewer() {
    if (this.elements.viewer.hidden) return;
    this.elements.viewerVideo.pause();
    this.elements.viewerVideo.removeAttribute("src");
    this.elements.viewerImage.removeAttribute("src");
    this.elements.viewer.hidden = true;
    this.elements.titleBar.inert = false;
    this.elements.breadcrumbs.inert = false;
    this.elements.toolbar.inert = false;
    this.elements.workspace.inert = false;
    this.viewerEntry = null;
    this.pointers.clear();
    if (this.viewerReturnFocus?.isConnected) this.viewerReturnFocus.focus();
    this.viewerReturnFocus = null;
  }

  #trapViewerFocus(event) {
    const focusable = [...this.elements.viewer.querySelectorAll(
      "button:not(:disabled), video[controls]",
    )].filter((element) => !element.closest("[hidden]"));
    if (!focusable.length) return;
    const current = focusable.indexOf(this.document.activeElement);
    const next = event.shiftKey
      ? (current <= 0 ? focusable.length - 1 : current - 1)
      : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
    event.preventDefault();
    focusable[next].focus();
  }

  #stepViewer(direction) {
    const media = this.#visibleMedia();
    if (!this.viewerEntry || !media.length) return;
    const current = media.findIndex((entry) => entry.path === this.viewerEntry.path);
    const next = Math.min(media.length - 1, Math.max(0, current + direction));
    if (next !== current) this.openViewer(media[next]);
  }

  #updateViewerNavigation() {
    const media = this.#visibleMedia();
    const index = media.findIndex((entry) => entry.path === this.viewerEntry?.path);
    this.elements.previous.disabled = index <= 0;
    this.elements.next.disabled = index < 0 || index >= media.length - 1;
  }

  #resetTransform() {
    this.transform = { zoom: 1, x: 0, y: 0 };
    this.#applyTransform();
  }

  #zoomBy(factor) {
    this.#setZoom(this.transform.zoom * factor);
  }

  #setZoom(zoom, point = { x: 0, y: 0 }) {
    this.transform = zoomBrowseTransform(this.transform, zoom, point);
    this.#applyTransform();
  }

  #transformMetrics() {
    const bounds = this.elements.viewerStage.getBoundingClientRect();
    return {
      stageWidth: bounds.width,
      stageHeight: bounds.height,
      naturalWidth: this.elements.viewerImage.naturalWidth,
      naturalHeight: this.elements.viewerImage.naturalHeight,
    };
  }

  #applyTransform() {
    this.transform = clampBrowseTransform(this.transform, this.#transformMetrics());
    this.elements.viewerImage.style.transform =
      `translate(${this.transform.x}px, ${this.transform.y}px) scale(${this.transform.zoom})`;
    this.elements.zoomValue.value = `${Math.round(this.transform.zoom * 100)}%`;
    this.elements.zoomOut.disabled = this.transform.zoom <= 1;
    this.elements.zoomIn.disabled = this.transform.zoom >= 8;
    this.elements.viewerStage.classList.toggle("can-pan", this.transform.zoom > 1);
  }

  #pointerDown(event) {
    if (!this.viewerEntry || !isImage(this.viewerEntry)) return;
    this.elements.viewerStage.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 1) {
      this.dragOrigin = {
        pointer: { x: event.clientX, y: event.clientY },
        transform: { ...this.transform },
      };
    } else if (this.pointers.size === 2) {
      const [first, second] = [...this.pointers.values()];
      this.pinchOrigin = {
        distance: Math.hypot(second.x - first.x, second.y - first.y),
        midpoint: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
        transform: { ...this.transform },
      };
    }
  }

  #pointerMove(event) {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2 && this.pinchOrigin) {
      const [first, second] = [...this.pointers.values()];
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const stage = this.elements.viewerStage.getBoundingClientRect();
      const point = {
        x: midpoint.x - stage.left - stage.width / 2,
        y: midpoint.y - stage.top - stage.height / 2,
      };
      this.transform = zoomBrowseTransform(
        this.pinchOrigin.transform,
        this.pinchOrigin.transform.zoom * (distance / Math.max(1, this.pinchOrigin.distance)),
        point,
      );
      this.transform.x += midpoint.x - this.pinchOrigin.midpoint.x;
      this.transform.y += midpoint.y - this.pinchOrigin.midpoint.y;
      this.#applyTransform();
    } else if (this.pointers.size === 1 && this.dragOrigin) {
      this.transform = {
        ...this.dragOrigin.transform,
        x: this.dragOrigin.transform.x + event.clientX - this.dragOrigin.pointer.x,
        y: this.dragOrigin.transform.y + event.clientY - this.dragOrigin.pointer.y,
      };
      this.#applyTransform();
    }
  }

  #pointerUp(event) {
    this.pointers.delete(event.pointerId);
    this.dragOrigin = null;
    this.pinchOrigin = null;
  }
}
