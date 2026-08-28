import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizePowerOfTwoResolution,
  reconcileSelectedDirectories,
  saveSettings,
} from "../core/settings.js";
import { matchesTagFilter, normalizeTagIds } from "../core/tags.js";
import { createScene, sceneShotPayload } from "../core/scene-state.js";
import {
  aggregateEntryTagCounts,
  createCommentaryVolumeController,
  MAX_COMMENTARY_VOLUME,
  normalizeCommentaryVolume,
  normalizeTagFrequency,
  suggestCommentaryTags,
} from "../core/commentary.js";
import { SpatialApp } from "../scene/spatial-app.js";
import { MediaApi, flattenDirectoryTree } from "../services/media-api.js";
import {
  applyTagPillPreview,
  createTagPill,
  TagPreviewResolver,
} from "./tag-pill.js";

const LIBRARY_POLL_INTERVAL_MS = 1000;

export function buildDirectoryHierarchy(entries) {
  const roots = [];
  const nodes = [];
  const stack = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const depth = Number.isInteger(entry.depth) && entry.depth >= 0 ? entry.depth : 0;
    while (stack.length && stack.at(-1).depth >= depth) {
      stack.pop();
    }

    const path = typeof entry.path === "string" ? entry.path.trim() : "";
    const node = {
      name: entry.name || (path ? path.split("/").at(-1) : "Media home"),
      path,
      depth,
      parent: stack.at(-1) ?? null,
      children: [],
      index: nodes.length,
    };
    if (node.parent) {
      node.parent.children.push(node);
    } else {
      roots.push(node);
    }
    nodes.push(node);
    stack.push(node);
  }

  return { roots, nodes: nodes.filter((node) => node.path) };
}

export function selectableDirectoryPaths(node) {
  const paths = [];
  const visit = (current) => {
    if (current.path) {
      paths.push(current.path);
    }
    current.children.forEach(visit);
  };
  visit(node);
  return paths;
}

export function directorySelectionState(node, selectedPaths) {
  const paths = selectableDirectoryPaths(node);
  const descendants = paths.length > 1 ? paths.slice(1) : paths;
  const selected = paths.filter((path) => selectedPaths.has(path)).length;
  return {
    checked: descendants.length > 0 && descendants.every((path) => selectedPaths.has(path)),
    indeterminate: selected > 0 && !descendants.every((path) => selectedPaths.has(path)),
  };
}

export function isDirectoryVisible(node, expandedPaths) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.path && !expandedPaths.has(parent.path)) {
      return false;
    }
  }
  return true;
}

export function directoryNestingLevel(node) {
  let level = 0;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.path) {
      level += 1;
    }
  }
  return level;
}

export class HomeController {
  constructor(document, { api = new MediaApi(), storage = localStorage } = {}) {
    this.document = document;
    this.api = api;
    this.storage = storage;
    this.settings = loadSettings(storage);
    this.directories = [];
    this.directoryHierarchy = buildDirectoryHierarchy([]);
    this.expandedDirectories = new Set();
    this.spatialApp = null;
    this.browseController = null;
    this.taggingController = null;
    this.libraryReady = false;
    this.libraryFailed = false;
    this.libraryId = null;
    this.xrSupported = false;
    this.uploadInProgress = false;
    this.libraryPollTimer = null;
    this.tags = [];
    this.tagsLoading = false;
    this.tagRequestActive = false;
    this.tagError = "";
    this.editingTagId = null;
    this.editingTagName = "";
    this.commentary = [];
    this.commentaryAvailable = null;
    this.commentaryLoading = false;
    this.commentaryLoadGeneration = 0;
    this.commentaryError = "";
    this.commentarySavingPaths = new Set();
    this.commentarySaveErrors = new Map();
    this.expandedCommentaryTags = new Set();
    this.commentaryFilterTagIds = [];
    this.commentaryFilterUntagged = false;
    this.commentaryCaptionDrafts = new Map();
    this.commentaryCaptionDirtyPaths = new Set();
    this.commentaryCaptionSavingPaths = new Set();
    this.commentaryCaptionSaveErrors = new Map();
    this.expandedCommentaryCaptions = new Set();
    this.commentaryVolumeDrafts = new Map();
    this.commentaryVolumeSavingPaths = new Set();
    this.commentaryVolumeSaveErrors = new Map();
    this.commentaryStatus = new Map();
    this.commentaryDurations = new Map();
    this.commentarySuggestOpen = false;
    this.commentarySuggestLoading = false;
    this.commentarySuggestLoadGeneration = 0;
    this.commentarySuggestMediaCounts = {};
    this.commentarySuggestCommentaryCounts = {};
    this.commentarySuggestError = "";
    this.commentaryAudio = document.createElement("audio");
    this.commentaryAudio.preload = "metadata";
    this.commentaryAudioVolume = createCommentaryVolumeController(this.commentaryAudio);
    this.commentaryPlayingPath = null;
    this.settingCards = [];
    this.panelMediaQuery = null;
    this.maximizedCard = null;
    this.maximizedCardTrigger = null;
    this.panelScrollPositions = new Map();
    this.reconcilingPanelLayout = false;
    this.focusRestoreTimer = null;
    this.sceneNoticeTimer = null;
    this.sceneList = [];
    this.sceneUiState = createScene({ id: null, name: "New scene", loop: true });
    this.selectedSceneId = null;
    this.tagPreviewResolver = new TagPreviewResolver({
      api: this.api,
      selectedDirectories: () => [...this.settings.mediaDirectories],
      onUpdate: (tagIds) => this.#refreshTagPillPreviews(tagIds),
    });
    this.commentaryAudioHandlers = {
      ended: () => this.#finishCommentaryPlayback("Finished"),
      error: () => this.#finishCommentaryPlayback("Playback could not be started."),
      loadedmetadata: () => this.#storeCommentaryDuration(),
    };
    this.commentaryAudio.addEventListener("ended", this.commentaryAudioHandlers.ended);
    this.commentaryAudio.addEventListener("error", this.commentaryAudioHandlers.error);
    this.commentaryAudio.addEventListener("loadedmetadata", this.commentaryAudioHandlers.loadedmetadata);
    this.elements = {
      home: document.querySelector("#home"),
      form: document.querySelector("#configuration"),
      connection: document.querySelector("#connection-status"),
      libraryCard: document.querySelector(".library-card"),
      libraryProgress: document.querySelector("#library-progress"),
      progressStatus: document.querySelector("#library-progress-status"),
      progressBar: document.querySelector("#library-progress-bar"),
      progressCounts: document.querySelector("#library-progress-counts"),
      progressPath: document.querySelector("#library-progress-path"),
      directoryState: document.querySelector("#directory-state"),
      directoryTree: document.querySelector("#directory-tree"),
      selectAll: document.querySelector("#select-all"),
      autoplay: document.querySelector("#autoplay"),
      speed: document.querySelector("#slideshow-speed"),
      speedValue: document.querySelector("#slideshow-value"),
      admDefaultDepthIntensity: document.querySelector("#adm-default-depth-intensity"),
      admDefaultDepthIntensityValue: document.querySelector("#adm-default-depth-intensity-value"),
      admMaxResolution: document.querySelector("#adm-max-resolution"),
      admMaxResolutionValue: document.querySelector("#adm-max-resolution-value"),
      tagsCard: document.querySelector(".tags-card"),
      tagName: document.querySelector("#tag-name"),
      tagSortOrder: document.querySelector("#tag-sort-order"),
      addTag: document.querySelector("#add-tag"),
      retryTags: document.querySelector("#retry-tags"),
      tagState: document.querySelector("#tag-state"),
      tagError: document.querySelector("#tag-error"),
      tagList: document.querySelector("#tag-list"),
      commentaryCard: document.querySelector("#commentary-card"),
      commentaryState: document.querySelector("#commentary-state"),
      commentaryError: document.querySelector("#commentary-error"),
      suggestCommentaryTags: document.querySelector("#suggest-commentary-tags"),
      commentarySuggestHint: document.querySelector("#commentary-suggest-hint"),
      commentarySuggestPopup: document.querySelector("#commentary-suggest-popup"),
      commentarySuggestClose: document.querySelector("#commentary-suggest-close"),
      commentarySuggestSummary: document.querySelector("#commentary-suggest-summary"),
      commentarySuggestList: document.querySelector("#commentary-suggest-list"),
      commentarySuggestDistribution: document.querySelector("#commentary-suggest-distribution"),
      commentaryFilter: document.querySelector("#commentary-filter"),
      commentaryList: document.querySelector("#commentary-list"),
      retryCommentary: document.querySelector("#retry-commentary"),
      captionSize: document.querySelector("#caption-size"),
      captionSizeValue: document.querySelector("#caption-size-value"),
      captionTransparency: document.querySelector("#caption-transparency"),
      captionTransparencyValue: document.querySelector("#caption-transparency-value"),
      captionDistance: document.querySelector("#caption-distance"),
      captionDistanceValue: document.querySelector("#caption-distance-value"),
      launch: document.querySelector("#launch-button"),
      preview: document.querySelector("#preview-button"),
      upload: document.querySelector("#upload-button"),
      uploadInput: document.querySelector("#upload-input"),
      browse: document.querySelector("#browse-button"),
      tagging: document.querySelector("#tagging-button"),
      support: document.querySelector("#xr-support"),
      error: document.querySelector("#app-error"),
      sceneShell: document.querySelector("#scene-shell"),
      sceneHud: document.querySelector(".scene-hud"),
      sceneNotice: document.querySelector("#scene-notice"),
      canvas: document.querySelector("#scene"),
      exitPreview: document.querySelector("#exit-preview"),
      sceneControls: document.querySelector("#scene-controls"),
      sceneControlsHome: document.querySelector("#scene-controls-home"),
      sceneSelect: document.querySelector("#scene-select"),
      sceneCreateName: document.querySelector("#scene-create-name"),
      sceneCreateButton: document.querySelector("#scene-create-button"),
      scenePlaybackToggle: document.querySelector("#scene-playback-toggle"),
      sceneShotSelect: document.querySelector("#scene-shot-select"),
      sceneLoopMode: document.querySelector("#scene-loop-mode"),
      sceneDuration: document.querySelector("#scene-duration"),
      sceneDurationValue: document.querySelector("#scene-duration-value"),
      sceneCaptureDelete: document.querySelector("#scene-capture-delete"),
    };
  }

  async start() {
    this.#setupAccordions();
    this.#bindEvents();
    this.#renderSettings();
    this.#renderTags();
    this.#renderCommentary();
    this.#renderSceneControls();
    this.#updateLaunchAvailability();
    await Promise.all([this.#loadLibrary(), this.#detectXr(), this.#loadCommentary()]);
  }

  #bindEvents() {
    this.elements.autoplay.addEventListener("change", () => {
      this.settings.autoplayVideos = this.elements.autoplay.checked;
      this.#persist();
    });
    this.elements.speed.addEventListener("input", () => {
      this.settings.slideshowIntervalMs = Number(this.elements.speed.value) * 1000;
      this.elements.speedValue.textContent = `${this.elements.speed.value} sec`;
      this.#persist();
    });
    this.elements.admDefaultDepthIntensity.addEventListener("input", () => {
      this.settings.admDefaultDepthIntensity = Number(this.elements.admDefaultDepthIntensity.value);
      this.elements.admDefaultDepthIntensityValue.textContent =
        `${this.settings.admDefaultDepthIntensity.toFixed(2)}×`;
      this.#persist();
    });
    this.elements.admMaxResolution.addEventListener("input", () => {
      this.settings.admMaxResolution = normalizePowerOfTwoResolution(
        Number(this.elements.admMaxResolution.value),
      );
      this.elements.admMaxResolution.value = String(this.settings.admMaxResolution);
      this.elements.admMaxResolutionValue.textContent = `${this.settings.admMaxResolution} px`;
      this.#persist();
    });
    this.elements.tagName.addEventListener("input", () => this.#renderTags());
    this.elements.tagSortOrder.addEventListener("change", () => {
      this.settings.tagSortOrder = this.elements.tagSortOrder.value;
      this.#persist();
      this.#renderTags();
    });
    this.elements.tagName.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.#createTag();
      }
    });
    this.elements.addTag.addEventListener("click", () => this.#createTag());
    this.elements.retryTags.addEventListener("click", () => this.#loadTags());
    this.elements.retryCommentary.addEventListener("click", () => this.#loadCommentary());
    this.elements.suggestCommentaryTags.addEventListener(
      "click",
      () => this.#openCommentarySuggestPopup(),
    );
    this.elements.commentarySuggestClose.addEventListener("click", () => {
      this.commentarySuggestOpen = false;
      this.#renderCommentary();
    });
    this.elements.commentarySuggestPopup.addEventListener("click", (event) => {
      if (event.target === this.elements.commentarySuggestPopup) {
        this.commentarySuggestOpen = false;
        this.#renderCommentary();
      }
    });
    this.elements.captionSize.addEventListener("input", () => {
      this.settings.captionSize = Number(this.elements.captionSize.value);
      this.#renderCaptionSettings();
      this.#persist();
    });
    this.elements.captionTransparency.addEventListener("input", () => {
      this.settings.captionTransparency = Number(this.elements.captionTransparency.value);
      this.#renderCaptionSettings();
      this.#persist();
    });
    this.elements.captionDistance.addEventListener("input", () => {
      this.settings.captionDistance = Number(this.elements.captionDistance.value);
      this.#renderCaptionSettings();
      this.#persist();
    });
    this.elements.selectAll.addEventListener("click", () => {
      if (!this.libraryReady) {
        return;
      }
      const selectable = this.directoryHierarchy.nodes;
      const allSelected = selectable.every((directory) =>
        this.settings.mediaDirectories.includes(directory.path),
      );
      this.settings.mediaDirectories = allSelected
        ? []
        : this.#canonicalDirectoryPaths(selectable.map((directory) => directory.path));
      this.#persist();
      this.#renderDirectories();
      this.#refreshCommentarySuggestData({ refreshMedia: true });
    });
    this.elements.upload.addEventListener("click", () => {
      if (this.elements.upload.disabled) {
        return;
      }
      this.elements.uploadInput.click();
    });
    this.elements.uploadInput.addEventListener("change", () => {
      this.#uploadSelectedImages().catch((error) => this.#showError(error));
    });
    this.elements.preview.addEventListener("click", () => this.openScene(false));
    this.elements.launch.addEventListener("click", () => this.openScene(true));
    this.elements.sceneCreateButton.addEventListener("click", () => {
      this.#createScene().catch((error) => this.#showError(error));
    });
    this.elements.sceneSelect.addEventListener("change", () => {
      this.#selectSceneFromUi().catch((error) => this.#showError(error));
    });
    this.elements.scenePlaybackToggle.addEventListener("click", () => {
      this.#toggleScenePlayback().catch((error) => this.#showError(error));
    });
    this.elements.sceneShotSelect.addEventListener("change", () => {
      this.#selectSceneShotFromUi().catch((error) => this.#showError(error));
    });
    this.elements.sceneLoopMode.addEventListener("change", () => {
      this.#setSceneLoopMode().catch((error) => this.#showError(error));
    });
    this.elements.sceneDuration.addEventListener("input", () => {
      this.elements.sceneDurationValue.textContent = `${this.elements.sceneDuration.value} sec`;
    });
    this.elements.sceneDuration.addEventListener("change", () => {
      this.#setSceneDurationFromUi().catch((error) => this.#showError(error));
    });
    this.elements.sceneCaptureDelete.addEventListener("click", () => {
      this.#captureOrDeleteSceneShot().catch((error) => this.#showError(error));
    });
    this.elements.browse.addEventListener("click", () => this.openBrowse());
    this.elements.tagging.addEventListener("click", () => this.openTagging());
    this.elements.exitPreview.addEventListener("click", () => this.closeScene());
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      if (this.commentarySuggestOpen) {
        event.preventDefault();
        this.commentarySuggestOpen = false;
        this.#renderCommentary();
        return;
      }
      if (!this.elements.sceneShell.hidden) {
        event.preventDefault();
        this.closeScene();
        return;
      }
      if (this.maximizedCard) {
        event.preventDefault();
        this.#restoreMaximizedPanel();
      }
    });
    window.addEventListener("pagehide", () => this.#disposeCommentaryAudio(), { once: true });
  }

  #renderSettings() {
    this.elements.autoplay.checked = this.settings.autoplayVideos;
    this.elements.speed.value = String(this.settings.slideshowIntervalMs / 1000);
    this.elements.admDefaultDepthIntensity.value = String(this.settings.admDefaultDepthIntensity);
    this.elements.admDefaultDepthIntensityValue.textContent =
      `${this.settings.admDefaultDepthIntensity.toFixed(2)}×`;
    this.settings.admMaxResolution = normalizePowerOfTwoResolution(this.settings.admMaxResolution);
    this.elements.admMaxResolution.value = String(this.settings.admMaxResolution);
    this.elements.admMaxResolutionValue.textContent = `${this.settings.admMaxResolution} px`;
    this.elements.speedValue.textContent = `${this.elements.speed.value} sec`;
    this.#renderCaptionSettings();
  }

  #setupAccordions() {
    this.settingCards = [...this.elements.form.querySelectorAll(".setting-card")];
    this.panelMediaQuery = window.matchMedia("(max-width: 760px)");
    this.settingCards.forEach((card, index) => {
      const heading = card.querySelector(".section-heading");
      if (!heading) return;
      this.panelScrollPositions.set(card, card.scrollTop);
      card.addEventListener("scroll", () => {
        if (!this.reconcilingPanelLayout) {
          this.panelScrollPositions.set(card, card.scrollTop);
        }
      }, { passive: true });
      card.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && this.maximizedCard === card && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          this.#restoreMaximizedPanel();
        }
      });
      const maximizeButton = card.querySelector("[data-panel-size-toggle]");
      maximizeButton?.addEventListener("click", () => this.#toggleMaximizedPanel(card, maximizeButton));
      const button = this.document.createElement("button");
      button.type = "button";
      button.className = "accordion-toggle";
      button.setAttribute("aria-label", `Toggle ${card.querySelector("h3")?.textContent ?? "panel"}`);
      button.addEventListener("click", () => {
        const opening = card.classList.contains("is-collapsed");
        this.settingCards.forEach((candidate) => candidate.classList.add("is-collapsed"));
        if (opening) card.classList.remove("is-collapsed");
        this.#reconcilePanelLayout();
      });
      const actions = card.querySelector(".section-actions");
      if (actions) {
        actions.append(button);
      } else {
        heading.append(button);
      }
      if (index > 0) card.classList.add("is-collapsed");
    });
    this.panelMediaQuery.addEventListener("change", () => this.#reconcilePanelLayout());
    this.#reconcilePanelLayout();
  }

  #reconcilePanelLayout() {
    if (!this.settingCards.length) {
      return;
    }
    this.reconcilingPanelLayout = true;
    if (this.maximizedCard) {
      this.elements.form.classList.add("has-maximized-panel");
      this.settingCards.forEach((card) => {
        const maximized = card === this.maximizedCard;
        card.classList.toggle("is-maximized", maximized);
        card.classList.toggle("is-collapsed", !maximized);
        card.hidden = !maximized;
      });
    } else {
      this.elements.form.classList.remove("has-maximized-panel");
      this.settingCards.forEach((card) => {
        card.hidden = false;
        card.classList.remove("is-maximized");
      });
      if (this.panelMediaQuery?.matches) {
        const expanded = this.settingCards.find((card) => !card.classList.contains("is-collapsed"))
          ?? this.settingCards[0];
        this.settingCards.forEach((card) => card.classList.toggle("is-collapsed", card !== expanded));
      } else {
        this.settingCards.forEach((card) => card.classList.remove("is-collapsed"));
      }
    }
    this.#updateAccordionButtons(this.settingCards);
    this.#updatePanelSizeButtons(this.settingCards);
    const restoreScrollPositions = () => {
      this.settingCards.forEach((card) => {
        const scrollTop = this.panelScrollPositions.get(card);
        if (!card.hidden && Number.isFinite(scrollTop)) {
          card.scrollTop = scrollTop;
        }
      });
    };
    restoreScrollPositions();
    requestAnimationFrame(() => {
      restoreScrollPositions();
      this.reconcilingPanelLayout = false;
    });
  }

  #toggleMaximizedPanel(card, button) {
    if (this.maximizedCard === card) {
      this.#restoreMaximizedPanel();
      return;
    }
    this.maximizedCard = card;
    this.maximizedCardTrigger = button;
    this.#reconcilePanelLayout();
  }

  #restoreMaximizedPanel() {
    if (!this.maximizedCard) {
      return false;
    }
    const restoreCardId = this.maximizedCard.id;
    this.maximizedCard = null;
    this.maximizedCardTrigger = null;
    this.#reconcilePanelLayout();
    if (restoreCardId) {
      const focusRestore = () => {
        const restoreTarget =
          this.document.getElementById(restoreCardId)?.querySelector("[data-panel-size-toggle]");
        restoreTarget?.focus({ preventScroll: true });
      };
      clearTimeout(this.focusRestoreTimer);
      this.document.activeElement?.blur?.();
      focusRestore();
      requestAnimationFrame(focusRestore);
      this.focusRestoreTimer = setTimeout(focusRestore, 50);
    }
    return true;
  }

  #updateAccordionButtons(cards) {
    cards.forEach((card) => {
      const expanded = !card.classList.contains("is-collapsed");
      const button = card.querySelector(".accordion-toggle");
      button?.setAttribute("aria-expanded", String(expanded));
      if (button) button.textContent = expanded ? "−" : "+";
    });
  }

  #updatePanelSizeButtons(cards) {
    cards.forEach((card) => {
      const button = card.querySelector("[data-panel-size-toggle]");
      if (!button) {
        return;
      }
      const maximized = card === this.maximizedCard;
      const rawLabel = card.querySelector(".panel-kicker")?.textContent?.trim() ?? "panel";
      const label = rawLabel[0].toUpperCase() + rawLabel.slice(1).toLowerCase();
      button.setAttribute(
        "aria-label",
        `${maximized ? "Restore" : "Maximize"} ${label} panel`,
      );
      button.setAttribute("aria-pressed", String(maximized));
      button.textContent = maximized ? "⤡" : "⤢";
    });
  }

  #renderCaptionSettings() {
    this.elements.captionSize.value = String(this.settings.captionSize);
    this.elements.captionSizeValue.textContent = `${Math.round(this.settings.captionSize * 100)}%`;
    this.elements.captionTransparency.value = String(this.settings.captionTransparency);
    this.elements.captionTransparencyValue.textContent =
      `${Math.round(this.settings.captionTransparency * 100)}%`;
    this.elements.captionDistance.value = String(this.settings.captionDistance);
    this.elements.captionDistanceValue.textContent =
      `${this.settings.captionDistance.toFixed(1)} m`;
  }

  async #loadLibrary() {
    try {
      await this.#pollLibraryStatus();
    } catch (error) {
      this.#failLibrary(error);
    }
  }

  async #pollLibraryStatus() {
    const status = await this.api.libraryStatus();
    if (!status || typeof status !== "object") {
      throw new Error("The media server returned an invalid library status.");
    }

    if (status.status === "scanning") {
      this.#renderScanProgress(status);
      this.#scheduleLibraryPoll();
      return;
    }

    if (status.status === "ready") {
      this.#stopLibraryPolling();
      await this.#loadReadyLibrary();
      return;
    }

    if (status.status === "error") {
      throw new Error(
        status.message ||
          "The media library scan failed. Check the media folder and server logs, then reload.",
      );
    }

    throw new Error("The media server returned an unknown library status.");
  }

  #scheduleLibraryPoll() {
    this.#stopLibraryPolling();
    this.libraryPollTimer = window.setTimeout(() => {
      this.libraryPollTimer = null;
      this.#pollLibraryStatus().catch((error) => this.#failLibrary(error));
    }, LIBRARY_POLL_INTERVAL_MS);
  }

  #stopLibraryPolling() {
    if (this.libraryPollTimer !== null) {
      window.clearTimeout(this.libraryPollTimer);
      this.libraryPollTimer = null;
    }
  }

  async #uploadSelectedImages() {
    if (!this.libraryReady) {
      this.elements.uploadInput.value = "";
      return;
    }
    const files = [...(this.elements.uploadInput.files ?? [])];
    this.elements.uploadInput.value = "";
    if (files.length === 0) {
      return;
    }
    this.uploadInProgress = true;
    this.#updateLaunchAvailability();
    this.#setConnectionStatus("Uploading images", "scanning");
    try {
      await this.api.uploadImages(files);
      await this.#loadReadyLibrary();
    } finally {
      this.uploadInProgress = false;
      this.#updateLaunchAvailability();
      if (this.libraryReady) {
        this.#setConnectionStatus("Local server", "connected");
      }
    }
  }

  #renderScanProgress(status) {
    this.libraryFailed = false;
    const scannedFiles = Number.isFinite(status.scanned_files) ? status.scanned_files : 0;
    const mediaFiles = Number.isFinite(status.media_files) ? status.media_files : 0;
    const directories = Number.isFinite(status.directories) ? status.directories : 0;
    const counts = `${scannedFiles} files scanned · ${mediaFiles} media files · ${directories} folders`;

    this.elements.libraryCard.setAttribute("aria-busy", "true");
    this.elements.libraryProgress.hidden = false;
    this.elements.progressBar.hidden = false;
    this.elements.progressStatus.textContent = "Scanning your media library";
    this.elements.progressCounts.textContent = counts;
    this.elements.progressBar.setAttribute(
      "aria-valuetext",
      `Scanning: ${scannedFiles} files scanned, ${mediaFiles} media files, ${directories} folders.`,
    );
    this.elements.progressPath.hidden = !status.current_path;
    this.elements.progressPath.textContent = status.current_path
      ? `Currently scanning: ${status.current_path}`
      : "";
    this.elements.directoryState.hidden = true;
    this.#renderTags();
    this.#setConnectionStatus("Scanning library", "scanning");
  }

  async #loadReadyLibrary() {
    this.elements.progressStatus.textContent = "Library scan complete. Loading folders…";
    this.elements.progressBar.setAttribute("aria-valuetext", "Library scan complete. Loading folders.");
    this.#setConnectionStatus("Loading folders", "scanning");

    const health = await this.api.health();
    this.libraryId = this.#libraryIdFromHealth(health);
    const tree = await this.api.tree();
    this.directories = flattenDirectoryTree(tree);
    this.directoryHierarchy = buildDirectoryHierarchy(this.directories);
    const available = this.directories
      .map((directory) => directory.path)
      .filter(Boolean);
    this.settings = reconcileSelectedDirectories(this.settings, available);
    this.settings.mediaDirectories = this.#canonicalDirectoryPaths(this.settings.mediaDirectories);
    this.#persist();
    this.libraryReady = true;
    this.libraryFailed = false;
    this.#renderTags();
    await this.#loadTags();
    this.elements.libraryCard.setAttribute("aria-busy", "false");
    this.elements.libraryProgress.hidden = true;
    this.#renderDirectories();
    this.#refreshCommentarySuggestData({ refreshMedia: true });
    await this.#refreshSceneList();
    this.#updateLaunchAvailability();
    this.#setConnectionStatus("Local server", "connected");
  }

  #failLibrary(error) {
    this.#stopLibraryPolling();
    this.libraryReady = false;
    this.libraryFailed = true;
    this.elements.libraryCard.setAttribute("aria-busy", "false");
    this.elements.libraryProgress.hidden = false;
    this.elements.progressBar.hidden = true;
    this.elements.progressStatus.textContent = "Library scanning needs attention";
    const message = this.#libraryErrorMessage(error);
    this.elements.progressCounts.textContent = message;
    this.elements.progressPath.hidden = true;
    this.elements.directoryState.textContent =
      "Preview is unavailable until the library scan completes. Start or update the media server, then reload.";
    this.elements.directoryState.hidden = false;
    this.elements.selectAll.disabled = true;
    this.commentarySuggestMediaCounts = {};
    this.commentarySuggestError = "";
    this.commentarySuggestLoading = false;
    this.commentarySuggestOpen = false;
    this.#renderTags();
    this.#updateLaunchAvailability();
    this.#setConnectionStatus("Server unavailable");
    this.#showError(new Error(message));
  }

  #libraryErrorMessage(error) {
    if (error?.status === 404) {
      return "Library status is unavailable. Update or restart the Souvenir media server, then reload.";
    }
    return error instanceof Error
      ? error.message
      : "The media server could not scan your library. Start it, then reload this page.";
  }

  #libraryIdFromHealth(health) {
    const libraryId = health?.library_id;
    if (typeof libraryId !== "string" || !libraryId.trim()) {
      throw new Error(
        "The media server is incompatible because it did not provide a valid library ID.",
      );
    }
    return libraryId;
  }

  #setConnectionStatus(text, state = "") {
    this.elements.connection.textContent = text;
    this.elements.connection.classList.toggle("connected", state === "connected");
    this.elements.connection.classList.toggle("scanning", state === "scanning");
  }

  #renderDirectories() {
    this.elements.directoryTree.replaceChildren();
    const selectable = this.directoryHierarchy.nodes;
    this.elements.directoryState.hidden = selectable.length > 0;
    if (selectable.length === 0) {
      this.elements.directoryState.textContent =
        "No media subfolders were found. Files in the media home remain available.";
    }

    const selectedPaths = new Set(this.settings.mediaDirectories);
    for (const directory of selectable) {
      if (!isDirectoryVisible(directory, this.expandedDirectories)) {
        continue;
      }

      const row = this.document.createElement("div");
      row.className = "directory-row";
      row.dataset.path = directory.path;
      row.style.setProperty("--directory-depth", String(directoryNestingLevel(directory)));
      const descendantPaths = selectableDirectoryPaths(directory);
      const hasDescendants = descendantPaths.length > 1;
      if (hasDescendants) {
        const toggle = this.document.createElement("button");
        const expanded = this.expandedDirectories.has(directory.path);
        toggle.type = "button";
        toggle.className = "directory-toggle";
        toggle.setAttribute("aria-expanded", String(expanded));
        toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${directory.name}`);
        toggle.textContent = expanded ? "▾" : "▸";
        toggle.addEventListener("click", () => {
          if (expanded) {
            this.expandedDirectories.delete(directory.path);
          } else {
            this.expandedDirectories.add(directory.path);
          }
          this.#renderDirectories();
        });
        row.append(toggle);
      } else {
        const spacer = this.document.createElement("span");
        spacer.className = "directory-toggle-spacer";
        spacer.setAttribute("aria-hidden", "true");
        row.append(spacer);
      }

      const label = this.document.createElement("label");
      label.className = "directory-label";
      label.htmlFor = `directory-checkbox-${directory.index}`;
      const input = this.document.createElement("input");
      const selection = directorySelectionState(directory, selectedPaths);
      input.id = label.htmlFor;
      input.type = "checkbox";
      input.value = directory.path;
      input.checked = selection.checked;
      input.indeterminate = selection.indeterminate;
      input.addEventListener("change", () => {
        this.#setDirectorySelection(directory, input.checked);
        this.#persist();
        this.#renderDirectories();
      });
      const marker = this.document.createElement("span");
      marker.className = "folder-mark";
      marker.textContent = "▱";
      const name = this.document.createElement("span");
      name.textContent = directory.name;
      label.append(input, marker, name);
      row.append(label);
      this.elements.directoryTree.append(row);
    }

    const allSelected =
      selectable.length > 0 &&
      selectable.every((directory) =>
        this.settings.mediaDirectories.includes(directory.path),
      );
    this.elements.selectAll.textContent = allSelected ? "Clear" : "Select all";
    this.elements.selectAll.disabled = !this.libraryReady;
  }

  #tagsUnavailable() {
    return (
      !this.libraryReady ||
      this.tagsLoading ||
      this.tagRequestActive ||
      Boolean(this.tagError)
    );
  }

  #tagErrorMessage(error) {
    const message =
      error instanceof Error ? error.message : "The tag request could not be completed.";
    return `Tags need attention: ${message}`;
  }

  #normalizeTags(payload) {
    if (!payload || !Array.isArray(payload.tags)) {
      throw new Error("The media server returned invalid tag definitions.");
    }
    return payload.tags
      .map((tag) => {
        if (
          !tag ||
          (typeof tag.id !== "string" && typeof tag.id !== "number") ||
          typeof tag.name !== "string" ||
          !tag.name.trim()
        ) {
          throw new Error("The media server returned an invalid tag definition.");
        }
        return { id: String(tag.id), name: tag.name.trim() };
      });
  }

  #compareTags(first, second) {
    const alpha =
      first.name.localeCompare(second.name, undefined, { sensitivity: "base" }) ||
      first.name.localeCompare(second.name) ||
      first.id.localeCompare(second.id);
    return this.settings.tagSortOrder === "alpha-desc" ? -alpha : alpha;
  }

  #orderedTags() {
    return [...this.tags].sort((first, second) => this.#compareTags(first, second));
  }

  async #loadTags() {
    if (!this.libraryReady) {
      this.#renderTags();
      return false;
    }
    this.tagsLoading = true;
    this.tagError = "";
    this.#renderTags();
    try {
      this.tags = this.#normalizeTags(await this.api.tags());
      this.#reconcileCommentaryFilter();
      await this.#loadCommentary();
      return true;
    } catch (error) {
      this.tagError = this.#tagErrorMessage(error);
      this.#showError(error);
      return false;
    } finally {
      this.tagsLoading = false;
      this.#renderTags();
      this.#renderCommentary();
    }
  }

  async #runTagRequest(request) {
    if (this.#tagsUnavailable()) {
      return;
    }
    this.tagRequestActive = true;
    this.tagError = "";
    this.#renderTags();
    try {
      await request();
      await this.#loadTags();
    } catch (error) {
      this.tagError = this.#tagErrorMessage(error);
      this.#showError(error);
    } finally {
      this.tagRequestActive = false;
      this.#renderTags();
    }
  }

  #createTag() {
    const name = this.elements.tagName.value.trim();
    if (!name) {
      this.elements.tagName.focus();
      return;
    }
    this.#runTagRequest(async () => {
      await this.api.createTag(name);
      this.elements.tagName.value = "";
    });
  }

  #startRename(tag) {
    if (this.#tagsUnavailable()) {
      return;
    }
    this.editingTagId = tag.id;
    this.editingTagName = tag.name;
    this.#renderTags();
    window.requestAnimationFrame(() => this.document.querySelector("#tag-rename-input")?.focus());
  }

  #cancelRename() {
    this.editingTagId = null;
    this.editingTagName = "";
    this.#renderTags();
  }

  #renameTag(tag) {
    const name = this.editingTagName.trim();
    if (!name) {
      this.document.querySelector("#tag-rename-input")?.focus();
      return;
    }
    this.#runTagRequest(async () => {
      await this.api.renameTag(tag.id, name);
      this.editingTagId = null;
      this.editingTagName = "";
    });
  }

  #deleteTag(tag) {
    this.#runTagRequest(() => this.api.deleteTag(tag.id));
  }

  #refreshTagPillPreviews(tagIds = null) {
    const relevant = tagIds ? new Set(normalizeTagIds(tagIds)) : null;
    this.document.querySelectorAll(".tag-pill[data-tag-id]").forEach((pill) => {
      if (relevant && !relevant.has(pill.dataset.tagId)) return;
      applyTagPillPreview(pill, this.tagPreviewResolver.previewFor(pill.dataset.tagId));
    });
  }

  #renderTags() {
    const unavailable = this.#tagsUnavailable();
    const waitingForLibrary = !this.libraryReady;
    this.elements.tagsCard.setAttribute(
      "aria-busy",
      String(
        (waitingForLibrary && !this.libraryFailed) ||
          this.tagsLoading ||
          this.tagRequestActive,
      ),
    );
    this.elements.tagName.disabled = unavailable;
    this.elements.tagSortOrder.disabled = unavailable;
    this.elements.tagSortOrder.value = this.settings.tagSortOrder;
    this.elements.addTag.disabled = unavailable || !this.elements.tagName.value.trim();
    this.elements.retryTags.hidden = !this.tagError;
    this.elements.retryTags.disabled = this.tagsLoading || this.tagRequestActive;
    this.elements.tagError.hidden = !this.tagError;
    this.elements.tagError.textContent = this.tagError;

    if (this.libraryFailed) {
      this.elements.tagState.textContent =
        "Tags are unavailable until the library scan succeeds.";
    } else if (waitingForLibrary) {
      this.elements.tagState.textContent = "Tags will be available after the library scan completes.";
    } else if (this.tagsLoading) {
      this.elements.tagState.textContent = "Loading shared tags…";
    } else if (this.tagRequestActive) {
      this.elements.tagState.textContent = "Saving tag changes…";
    } else if (this.tags.length === 0) {
      this.elements.tagState.textContent = "No shared tags yet. Add one to begin filtering.";
    } else {
      this.elements.tagState.textContent = `${this.tags.length} shared tag${this.tags.length === 1 ? "" : "s"} available for filtering.`;
    }

    this.elements.tagList.replaceChildren();
    const orderedTags = this.#orderedTags();
    this.tagPreviewResolver.ensure(orderedTags.map((tag) => tag.id));
    for (const tag of orderedTags) {
      const row = this.document.createElement("div");
      row.className = "tag-row";
      row.setAttribute("role", "listitem");

      if (this.editingTagId === tag.id) {
        row.classList.add("editing");
        const input = this.document.createElement("input");
        input.id = "tag-rename-input";
        input.className = "tag-edit-input";
        input.type = "text";
        input.maxLength = 80;
        input.value = this.editingTagName;
        input.disabled = unavailable;
        input.setAttribute("aria-label", `Rename ${tag.name}`);
        input.addEventListener("input", () => {
          this.editingTagName = input.value;
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.#renameTag(tag);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            this.#cancelRename();
          }
        });
        const actions = this.#tagActions([
          ["Save", `Save renamed tag ${tag.name}`, () => this.#renameTag(tag)],
          ["Cancel", `Cancel renaming ${tag.name}`, () => this.#cancelRename()],
        ], unavailable);
        row.append(input, actions);
      } else {
        const name = createTagPill(this.document, {
          tagId: tag.id,
          label: tag.name,
          className: "tag-name",
        });
        applyTagPillPreview(name, this.tagPreviewResolver.previewFor(tag.id));
        const actions = this.#tagActions([
          ["Rename", `Rename ${tag.name}`, () => this.#startRename(tag)],
          ["Delete", `Delete ${tag.name}`, () => this.#deleteTag(tag), "delete"],
        ], unavailable);
        row.append(name, actions);
      }
      this.elements.tagList.append(row);
    }
    this.#renderCommentary();
  }

  #tagActions(actions, disabled) {
    const container = this.document.createElement("div");
    container.className = "tag-actions";
    for (const [label, ariaLabel, callback, modifier = ""] of actions) {
      const button = this.document.createElement("button");
      button.type = "button";
      button.className = `tag-action ${modifier}`.trim();
      button.textContent = label;
      button.setAttribute("aria-label", ariaLabel);
      button.disabled = disabled;
      button.addEventListener("click", callback);
      container.append(button);
    }
    return container;
  }

  #normalizeCommentary(payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.entries)) {
      throw new Error("The media server returned invalid commentary.");
    }
    return {
      available: payload.available === true,
      entries: payload.entries
        .map((entry) => {
          if (!entry || typeof entry.path !== "string" || !entry.path) {
            return null;
          }
          const path = entry.path;
          const name = typeof entry.name === "string" && entry.name.trim()
            ? entry.name.trim()
            : path.split("/").at(-1);
          return {
            name,
            path,
            mediaType: typeof entry.media_type === "string" ? entry.media_type : "",
            tagIds: normalizeTagIds(entry.tag_ids),
            caption: typeof entry.caption === "string" ? entry.caption : "",
            volume: normalizeCommentaryVolume(entry.volume),
          };
        })
        .filter(Boolean)
        .sort((first, second) => first.path.localeCompare(second.path)),
    };
  }

  async #loadCommentary() {
    const generation = ++this.commentaryLoadGeneration;
    this.commentaryLoading = true;
    this.commentaryError = "";
    this.#renderCommentary();
    try {
      const payload = this.#normalizeCommentary(await this.api.commentary());
      if (generation !== this.commentaryLoadGeneration) return;
      this.commentaryAvailable = payload.available;
      this.commentary = payload.entries;
      this.commentarySuggestCommentaryCounts = aggregateEntryTagCounts(this.commentary);
      const currentPaths = new Set(this.commentary.map((entry) => entry.path));
      for (const entry of this.commentary) {
        if (!this.commentaryCaptionDirtyPaths.has(entry.path)) {
          this.commentaryCaptionDrafts.set(entry.path, entry.caption);
        }
        if (!this.commentaryVolumeSavingPaths.has(entry.path)) {
          this.commentaryVolumeDrafts.set(entry.path, entry.volume);
        }
      }
      for (const drafts of [
        this.commentaryCaptionDrafts,
        this.commentaryCaptionSaveErrors,
        this.commentaryVolumeDrafts,
        this.commentaryVolumeSaveErrors,
      ]) {
        for (const path of drafts.keys()) {
          if (!currentPaths.has(path)) drafts.delete(path);
        }
      }
      for (const paths of [
        this.commentaryCaptionDirtyPaths,
        this.commentaryCaptionSavingPaths,
        this.expandedCommentaryCaptions,
        this.commentaryVolumeSavingPaths,
      ]) {
        for (const path of paths) {
          if (!currentPaths.has(path)) paths.delete(path);
        }
      }
      if (
        this.commentaryPlayingPath &&
        !this.commentary.some((entry) => entry.path === this.commentaryPlayingPath)
      ) {
        const stopped = this.#stopCommentaryPlayback();
        if (stopped) this.commentaryStatus.set(stopped, "Stopped");
      }
    } catch (error) {
      if (generation !== this.commentaryLoadGeneration) return;
      if (!this.commentary.length) this.commentaryAvailable = null;
      this.commentarySuggestCommentaryCounts = {};
      this.commentaryError = error instanceof Error
        ? error.message
        : "Commentary could not be loaded.";
    } finally {
      if (generation !== this.commentaryLoadGeneration) return;
      this.commentaryLoading = false;
      this.#refreshCommentarySuggestData({ refreshMedia: false });
      this.#renderCommentary();
    }
  }

  #commentaryTagsAvailable() {
    return this.libraryReady && !this.tagsLoading && !this.tagRequestActive && !this.tagError;
  }

  #reconcileCommentaryFilter() {
    const available = new Set(this.tags.map((tag) => tag.id));
    this.commentaryFilterTagIds = this.commentaryFilterTagIds
      .filter((tagId) => available.has(tagId));
  }

  #filteredCommentary() {
    if (this.commentaryFilterUntagged) {
      return this.commentary.filter((entry) => normalizeTagIds(entry.tagIds).length === 0);
    }
    return this.commentary.filter((entry) =>
      matchesTagFilter({ tag_ids: entry.tagIds }, this.commentaryFilterTagIds));
  }

  #setCommentaryFilter({ tagIds = this.commentaryFilterTagIds, untagged = false } = {}) {
    this.commentaryFilterTagIds = normalizeTagIds(tagIds);
    this.commentaryFilterUntagged = Boolean(untagged);
    if (this.commentaryFilterUntagged) this.commentaryFilterTagIds = [];
    this.#renderCommentary();
  }

  #commentaryFilterButton(label, { active, onClick }) {
    const button = this.document.createElement("button");
    button.type = "button";
    button.className = "commentary-filter-button";
    button.textContent = label;
    button.setAttribute("aria-pressed", String(active));
    button.addEventListener("click", onClick);
    return button;
  }

  #renderCommentaryFilter() {
    const container = this.elements.commentaryFilter;
    container.replaceChildren();
    container.hidden = (
      this.commentaryLoading
      || Boolean(this.commentaryError)
      || !this.commentaryAvailable
      || this.commentary.length === 0
    );
    if (container.hidden) return;

    const label = this.document.createElement("strong");
    label.className = "commentary-filter-label";
    label.textContent = "Filter sounds";
    const allActive = !this.commentaryFilterUntagged
      && this.commentaryFilterTagIds.length === 0;
    container.append(
      label,
      this.#commentaryFilterButton("All", {
        active: allActive,
        onClick: () => this.#setCommentaryFilter({ tagIds: [], untagged: false }),
      }),
      this.#commentaryFilterButton("Untagged only", {
        active: this.commentaryFilterUntagged,
        onClick: () => this.#setCommentaryFilter({
          tagIds: [],
          untagged: !this.commentaryFilterUntagged,
        }),
      }),
    );

    const selected = new Set(this.commentaryFilterTagIds);
    for (const tag of this.tags) {
      const option = this.document.createElement("label");
      option.className = "commentary-filter-option";
      const checkbox = this.document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = tag.id;
      checkbox.checked = selected.has(tag.id);
      checkbox.setAttribute("aria-label", `Filter commentary by ${tag.name}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(tag.id);
        else selected.delete(tag.id);
        this.#setCommentaryFilter({ tagIds: [...selected], untagged: false });
      });
      const chip = this.document.createElement("span");
      chip.textContent = tag.name;
      option.append(checkbox, chip);
      container.append(option);
    }
  }

  #commentarySuggestDirectoryRoots() {
    const ordered = this.#canonicalDirectoryPaths(this.settings.mediaDirectories);
    const roots = [];
    for (const directory of ordered) {
      if (!directory) continue;
      const nested = roots.some((root) => directory.startsWith(`${root}/`));
      if (!nested) roots.push(directory);
    }
    return roots;
  }

  async #collectMediaTagCountsForDirectories(directories) {
    const counts = {};
    const pending = [...directories];
    const visited = new Set();
    while (pending.length > 0) {
      const path = pending.pop();
      if (!path || visited.has(path)) continue;
      visited.add(path);
      const payload = await this.api.directory(path, this.settings.mediaDirectories);
      const entries = Array.isArray(payload) ? payload : payload?.entries ?? [];
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        if (entry.kind === "directory" && typeof entry.path === "string" && entry.path) {
          pending.push(entry.path);
          continue;
        }
        if (entry.kind !== "file") continue;
        for (const tagId of normalizeTagIds(entry.tag_ids)) {
          counts[tagId] = (counts[tagId] ?? 0) + 1;
        }
      }
    }
    return counts;
  }

  async #refreshCommentarySuggestData({ refreshMedia } = { refreshMedia: true }) {
    this.commentarySuggestCommentaryCounts = aggregateEntryTagCounts(this.commentary);
    if (!refreshMedia) {
      return;
    }
    const generation = ++this.commentarySuggestLoadGeneration;
    const roots = this.#commentarySuggestDirectoryRoots();
    if (!this.libraryReady || roots.length === 0) {
      this.commentarySuggestLoading = false;
      this.commentarySuggestError = "";
      this.commentarySuggestMediaCounts = {};
      this.#renderCommentary();
      return;
    }
    this.commentarySuggestLoading = true;
    this.commentarySuggestError = "";
    this.#renderCommentary();
    try {
      const counts = await this.#collectMediaTagCountsForDirectories(roots);
      if (generation !== this.commentarySuggestLoadGeneration) return;
      this.commentarySuggestMediaCounts = counts;
    } catch (error) {
      if (generation !== this.commentarySuggestLoadGeneration) return;
      this.commentarySuggestError = error instanceof Error
        ? error.message
        : "Tag coverage could not be collected.";
      this.#showError(error);
    } finally {
      if (generation !== this.commentarySuggestLoadGeneration) return;
      this.commentarySuggestLoading = false;
      this.#renderCommentary();
    }
  }

  #openCommentarySuggestPopup() {
    if (this.#commentarySuggestDisabledReason()) return;
    this.commentarySuggestOpen = true;
    this.#renderCommentary();
    window.requestAnimationFrame(() => this.elements.commentarySuggestClose?.focus());
  }

  #commentarySuggestDisabledReason() {
    if (!this.libraryReady) {
      return "Wait for the media library to finish loading.";
    }
    if (this.settings.mediaDirectories.length === 0) {
      return "Select at least one folder to compare media and commentary tags.";
    }
    if (this.commentarySuggestLoading) {
      return "Collecting tag coverage from selected folders…";
    }
    if (this.commentarySuggestError) {
      return `Tag coverage is unavailable: ${this.commentarySuggestError}`;
    }
    if (Object.keys(this.commentarySuggestMediaCounts).length === 0) {
      return "No tagged media was found in the selected folders.";
    }
    if (Object.keys(this.commentarySuggestCommentaryCounts).length === 0) {
      return "No tagged commentary sounds were found.";
    }
    return "";
  }

  #commentaryTagName(tagId) {
    return this.tags.find((tag) => tag.id === tagId)?.name ?? tagId;
  }

  #formatTagFrequency(value) {
    return `${(value * 100).toFixed(1)}%`;
  }

  #renderCommentarySuggest() {
    const {
      suggestCommentaryTags: button,
      commentarySuggestHint: hint,
      commentarySuggestPopup: popup,
      commentarySuggestSummary: summary,
      commentarySuggestList: suggestionList,
      commentarySuggestDistribution: distribution,
    } = this.elements;
    const disabledReason = this.#commentarySuggestDisabledReason();
    button.disabled = Boolean(disabledReason);
    hint.textContent = disabledReason || "Compare tag coverage and get suggestions for new commentary.";
    if (disabledReason) {
      this.commentarySuggestOpen = false;
    }
    popup.hidden = !this.commentarySuggestOpen;
    if (!this.commentarySuggestOpen) {
      return;
    }
    const mediaFrequency = normalizeTagFrequency(this.commentarySuggestMediaCounts);
    const commentaryFrequency = normalizeTagFrequency(this.commentarySuggestCommentaryCounts);
    const suggestions = suggestCommentaryTags(
      this.commentarySuggestMediaCounts,
      this.commentarySuggestCommentaryCounts,
      { limit: 5 },
    );
    summary.textContent = [
      `Media tags: ${Object.keys(mediaFrequency).length}`,
      `Commentary tags: ${Object.keys(commentaryFrequency).length}`,
      `Suggestions: ${suggestions.length}`,
    ].join(" · ");
    suggestionList.replaceChildren();
    if (suggestions.length === 0) {
      const item = this.document.createElement("li");
      item.textContent = "Commentary tags already match or exceed media coverage.";
      suggestionList.append(item);
    } else {
      for (const suggestion of suggestions) {
        const item = this.document.createElement("li");
        item.textContent = `${this.#commentaryTagName(suggestion.tag)} (${this.#formatTagFrequency(suggestion.gap)} gap)`;
        suggestionList.append(item);
      }
    }
    distribution.replaceChildren();
    const tags = [...new Set([
      ...Object.keys(mediaFrequency),
      ...Object.keys(commentaryFrequency),
    ])].sort((left, right) =>
      (mediaFrequency[right] ?? 0) - (mediaFrequency[left] ?? 0)
      || (commentaryFrequency[right] ?? 0) - (commentaryFrequency[left] ?? 0)
      || this.#commentaryTagName(left).localeCompare(this.#commentaryTagName(right), undefined, {
        sensitivity: "base",
        numeric: true,
      }));
    for (const tagId of tags) {
      const row = this.document.createElement("div");
      row.className = "commentary-suggest-distribution-row";
      const name = this.document.createElement("strong");
      name.textContent = this.#commentaryTagName(tagId);
      const frequencies = this.document.createElement("span");
      frequencies.textContent =
        `${this.#formatTagFrequency(mediaFrequency[tagId] ?? 0)} media · ${this.#formatTagFrequency(commentaryFrequency[tagId] ?? 0)} commentary`;
      const gap = this.document.createElement("span");
      gap.className = "commentary-suggest-gap";
      const value = (mediaFrequency[tagId] ?? 0) - (commentaryFrequency[tagId] ?? 0);
      gap.textContent = `${value >= 0 ? "+" : ""}${this.#formatTagFrequency(value)}`;
      row.append(name, frequencies, gap);
      distribution.append(row);
    }
  }

  #renderCommentary() {
    const {
      commentaryCard,
      commentaryState,
      commentaryError,
      commentaryList,
      retryCommentary,
    } = this.elements;
    commentaryCard.setAttribute("aria-busy", String(this.commentaryLoading));
    commentaryError.hidden = !this.commentaryError;
    commentaryError.textContent = this.commentaryError
      ? `Commentary needs attention: ${this.commentaryError}`
      : "";
    retryCommentary.hidden = !this.commentaryError;
    retryCommentary.disabled = this.commentaryLoading;
    commentaryList.replaceChildren();
    this.#renderCommentarySuggest();
    this.#renderCommentaryFilter();

    if (this.commentaryLoading) {
      commentaryState.textContent = "Loading commentary…";
      return;
    }
    if (this.commentaryError) {
      commentaryState.textContent = "Commentary is unavailable right now. Your gallery is still ready to use.";
      return;
    }
    if (!this.commentaryAvailable) {
      commentaryState.textContent =
        "Commentary is not configured. Set SOUVENIR_COMMENTARY_DIR on the media server, then reload.";
      return;
    }
    if (this.commentary.length === 0) {
      commentaryState.textContent = "No commentary audio files were found.";
      return;
    }

    const filtered = this.#filteredCommentary();
    const filterActive = this.commentaryFilterUntagged || this.commentaryFilterTagIds.length > 0;
    commentaryState.textContent = filterActive
      ? `${filtered.length} of ${this.commentary.length} commentary audio files match this filter.`
      : `${this.commentary.length} commentary audio file${this.commentary.length === 1 ? "" : "s"} available.`;
    for (const entry of filtered) {
      commentaryList.append(this.#commentaryRow(entry));
    }
  }

  #commentaryRow(entry) {
    const row = this.document.createElement("article");
    row.className = "commentary-row";
    row.dataset.path = entry.path;
    row.setAttribute("role", "listitem");

    const details = this.document.createElement("div");
    details.className = "commentary-file";
    const titleLine = this.document.createElement("div");
    titleLine.className = "commentary-title-line";
    const name = this.document.createElement("strong");
    name.className = "commentary-name";
    name.textContent = entry.name;
    const inlineTags = this.document.createElement("span");
    inlineTags.className = "commentary-inline-tags";
    const tagNames = new Map(this.tags.map((tag) => [tag.id, tag.name]));
    const assignedNames = normalizeTagIds(entry.tagIds)
      .map((tagId) => tagNames.get(tagId))
      .filter(Boolean);
    for (const tagName of assignedNames.length ? assignedNames : ["Untagged"]) {
      const chip = this.document.createElement("span");
      chip.className = "commentary-inline-tag";
      chip.textContent = tagName;
      inlineTags.append(chip);
    }
    titleLine.append(name, inlineTags);
    const path = this.document.createElement("span");
    path.className = "commentary-path";
    path.textContent = entry.path === entry.name ? "" : entry.path;
    path.hidden = !path.textContent;
    const metadata = this.document.createElement("span");
    metadata.className = "commentary-metadata";
    const metadataParts = [];
    if (entry.mediaType) metadataParts.push(entry.mediaType);
    const duration = this.commentaryDurations.get(entry.path);
    if (Number.isFinite(duration)) metadataParts.push(this.#formatCommentaryDuration(duration));
    metadata.textContent = metadataParts.join(" · ");
    metadata.hidden = metadataParts.length === 0;
    const subline = this.document.createElement("span");
    subline.className = "commentary-subline";
    subline.append(path, metadata);
    details.append(titleLine, subline);

    const controls = this.document.createElement("div");
    controls.className = "commentary-controls";
    const playing = this.commentaryPlayingPath === entry.path;
    const play = this.document.createElement("button");
    play.type = "button";
    play.className = "commentary-play secondary-button";
    play.textContent = playing ? "Stop" : "Play";
    play.setAttribute("aria-label", `${playing ? "Stop" : "Play"} ${entry.name}`);
    play.addEventListener("click", () => this.#toggleCommentaryPlayback(entry));
    const status = this.document.createElement("span");
    status.className = "commentary-playback-status";
    status.setAttribute("role", "status");
    status.textContent = this.commentaryVolumeSaveErrors.get(entry.path)
      ?? this.commentaryStatus.get(entry.path)
      ?? "";
    const volume = this.#commentaryVolumeControl(entry);
    const assignment = this.#commentaryAssignment(entry);
    const captionEditor = this.#commentaryCaptionEditor(entry);
    controls.append(play, volume, assignment, captionEditor, status);

    row.append(details, controls);
    return row;
  }

  #commentaryVolumeControl(entry) {
    const label = this.document.createElement("label");
    label.className = "commentary-volume";
    const slider = this.document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = String(MAX_COMMENTARY_VOLUME);
    slider.step = "0.05";
    slider.value = String(this.commentaryVolumeDrafts.get(entry.path) ?? entry.volume);
    slider.disabled = this.commentaryVolumeSavingPaths.has(entry.path);
    slider.setAttribute("aria-label", `Volume for ${entry.name}`);
    const output = this.document.createElement("output");
    output.textContent = `${Math.round(Number(slider.value) * 100)}%`;
    slider.addEventListener("input", () => {
      const volume = normalizeCommentaryVolume(slider.value);
      this.commentaryVolumeDrafts.set(entry.path, volume);
      output.textContent = `${Math.round(volume * 100)}%`;
    });
    slider.addEventListener("change", () => {
      this.#saveCommentaryVolume(entry, normalizeCommentaryVolume(slider.value));
    });
    label.append(slider, output);
    return label;
  }

  async #saveCommentaryVolume(entry, volume) {
    if (this.commentaryVolumeSavingPaths.has(entry.path)) return;
    this.commentaryVolumeSavingPaths.add(entry.path);
    this.commentaryVolumeSaveErrors.delete(entry.path);
    try {
      const response = await this.api.saveCommentaryVolume(entry.path, volume);
      const savedVolume = normalizeCommentaryVolume(response?.volume);
      const current = this.commentary.find((item) => item.path === entry.path);
      if (current) current.volume = savedVolume;
      this.commentaryVolumeDrafts.set(entry.path, savedVolume);
      if (this.commentaryPlayingPath === entry.path) {
        this.commentaryAudioVolume.prepare(savedVolume);
        this.commentaryAudioVolume.apply(savedVolume);
      }
    } catch (error) {
      this.commentaryVolumeDrafts.set(entry.path, entry.volume);
      this.commentaryVolumeSaveErrors.set(
        entry.path,
        error instanceof Error ? `Volume save failed: ${error.message}` : "Volume save failed.",
      );
    } finally {
      this.commentaryVolumeSavingPaths.delete(entry.path);
      this.#renderCommentary();
    }
  }

  #commentaryCaptionEditor(entry) {
    const editor = this.document.createElement("details");
    editor.className = "commentary-caption-editor";
    editor.open = this.expandedCommentaryCaptions.has(entry.path);
    editor.addEventListener("toggle", () => {
      if (editor.open) {
        for (const tagEditor of this.document.querySelectorAll(
          ".commentary-tag-picker[open]",
        )) {
          tagEditor.open = false;
        }
        this.expandedCommentaryCaptions.add(entry.path);
      } else {
        this.expandedCommentaryCaptions.delete(entry.path);
      }
    });
    const summary = this.document.createElement("summary");
    summary.textContent = "Captions";
    summary.setAttribute("aria-label", `${entry.caption ? "Edit" : "Add"} captions for ${entry.name}`);
    const panel = this.document.createElement("div");
    panel.className = "commentary-editor-panel commentary-caption-panel";
    editor.append(summary, panel);

    const textarea = this.document.createElement("textarea");
    textarea.className = "commentary-caption-input";
    textarea.maxLength = 5000;
    textarea.rows = 3;
    textarea.value = this.commentaryCaptionDrafts.get(entry.path) ?? entry.caption;
    textarea.placeholder = "First message##Second message";
    textarea.setAttribute("aria-label", `Captions for ${entry.name}`);
    const saving = this.commentaryCaptionSavingPaths.has(entry.path);
    textarea.disabled = saving;

    const actions = this.document.createElement("div");
    actions.className = "commentary-caption-actions";
    const hint = this.document.createElement("small");
    hint.textContent = "Each message shows for 1 second. Each # adds a 1 second pause.";
    const save = this.document.createElement("button");
    save.type = "button";
    save.className = "secondary-button";
    save.textContent = saving ? "Saving…" : "Save captions";
    save.disabled = saving || !this.commentaryCaptionDirtyPaths.has(entry.path);
    save.setAttribute("aria-label", `Save captions for ${entry.name}`);
    const close = this.#commentaryEditorClose(editor, `Close captions for ${entry.name}`);
    textarea.addEventListener("input", () => {
      this.commentaryCaptionDrafts.set(entry.path, textarea.value);
      const dirty = textarea.value.trim() !== entry.caption;
      if (dirty) this.commentaryCaptionDirtyPaths.add(entry.path);
      else this.commentaryCaptionDirtyPaths.delete(entry.path);
      save.disabled = !dirty;
    });
    save.addEventListener("click", () => this.#saveCommentaryCaption(entry));
    actions.append(hint, close, save);
    panel.append(textarea, actions);

    const saveError = this.commentaryCaptionSaveErrors.get(entry.path);
    if (saveError) {
      const error = this.document.createElement("p");
      error.className = "commentary-row-error";
      error.setAttribute("role", "alert");
      error.textContent = saveError;
      panel.append(error);
    }
    return editor;
  }

  #commentaryEditorClose(editor, ariaLabel) {
    const close = this.document.createElement("button");
    close.type = "button";
    close.className = "secondary-button";
    close.textContent = "Close";
    close.setAttribute("aria-label", ariaLabel);
    close.addEventListener("click", () => {
      editor.open = false;
    });
    return close;
  }

  async #saveCommentaryCaption(entry) {
    if (this.commentaryCaptionSavingPaths.has(entry.path)) return;
    const caption = (this.commentaryCaptionDrafts.get(entry.path) ?? "").trim();
    this.commentaryCaptionSavingPaths.add(entry.path);
    this.commentaryCaptionSaveErrors.delete(entry.path);
    this.#renderCommentary();
    try {
      const response = await this.api.saveCommentaryCaption(entry.path, caption);
      const savedCaption = typeof response?.caption === "string" ? response.caption : caption;
      const current = this.commentary.find((item) => item.path === entry.path);
      if (current) current.caption = savedCaption;
      this.commentaryCaptionDrafts.set(entry.path, savedCaption);
      this.commentaryCaptionDirtyPaths.delete(entry.path);
      this.expandedCommentaryCaptions.delete(entry.path);
    } catch (error) {
      this.commentaryCaptionSaveErrors.set(
        entry.path,
        error instanceof Error
          ? `Could not save captions for ${entry.name}: ${error.message}`
          : `Could not save captions for ${entry.name}.`,
      );
    } finally {
      this.commentaryCaptionSavingPaths.delete(entry.path);
      this.#renderCommentary();
    }
  }

  #commentaryAssignment(entry) {
    const picker = this.document.createElement("details");
    picker.className = "commentary-tag-picker";
    picker.open = this.expandedCommentaryTags.has(entry.path);
    picker.addEventListener("toggle", () => {
      if (picker.open) {
        for (const captionEditor of this.document.querySelectorAll(
          ".commentary-caption-editor[open]",
        )) {
          captionEditor.open = false;
        }
        this.expandedCommentaryTags.add(entry.path);
      } else {
        this.expandedCommentaryTags.delete(entry.path);
      }
    });
    const summary = this.document.createElement("summary");
    summary.textContent = "Tags";
    summary.setAttribute("aria-label", `Edit tags for ${entry.name}`);
    const panel = this.document.createElement("div");
    panel.className = "commentary-editor-panel";
    picker.append(summary, panel);

    const tagsReady = this.#commentaryTagsAvailable();
    const saving = this.commentarySavingPaths.has(entry.path);
    if (!tagsReady) {
      const hint = this.document.createElement("p");
      hint.className = "commentary-tag-hint";
      hint.textContent = this.libraryFailed
        ? "Shared tags need the media library to be available."
        : "Shared tags are loading before assignments can be changed.";
      panel.append(hint);
      panel.append(this.#commentaryEditorClose(picker, `Close tags for ${entry.name}`));
      return picker;
    }
    if (this.tags.length === 0) {
      const hint = this.document.createElement("p");
      hint.className = "commentary-tag-hint";
      hint.textContent = "Create a shared tag above to assign it here.";
      panel.append(hint);
      panel.append(this.#commentaryEditorClose(picker, `Close tags for ${entry.name}`));
      return picker;
    }

    const fieldset = this.document.createElement("fieldset");
    fieldset.className = "commentary-tag-options";
    fieldset.disabled = saving;
    this.tagPreviewResolver.ensure(this.tags.map((tag) => tag.id));
    const selected = new Set(entry.tagIds);
    for (const tag of this.tags) {
      const label = this.document.createElement("label");
      label.className = "commentary-tag-option";
      const checkbox = this.document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(tag.id);
      checkbox.setAttribute("aria-label", `Assign ${tag.name} to ${entry.name}`);
      checkbox.addEventListener("change", () => {
        const tagIds = [...fieldset.querySelectorAll("input:checked")].map((input) => input.value);
        this.#saveCommentaryTags(entry, tagIds);
      });
      checkbox.value = tag.id;
      const chip = createTagPill(this.document, {
        tagId: tag.id,
        label: tag.name,
      });
      applyTagPillPreview(chip, this.tagPreviewResolver.previewFor(tag.id));
      label.append(checkbox, chip);
      fieldset.append(label);
    }
    panel.append(fieldset);
    const saveError = this.commentarySaveErrors.get(entry.path);
    if (saveError) {
      const error = this.document.createElement("p");
      error.className = "commentary-row-error";
      error.setAttribute("role", "alert");
      error.textContent = saveError;
      panel.append(error);
    }
    panel.append(this.#commentaryEditorClose(picker, `Close tags for ${entry.name}`));
    return picker;
  }

  async #saveCommentaryTags(entry, tagIds) {
    if (this.commentarySavingPaths.has(entry.path)) return;
    this.commentarySavingPaths.add(entry.path);
    this.commentarySaveErrors.delete(entry.path);
    this.#renderCommentary();
    try {
      const response = await this.api.saveCommentaryTags(entry.path, tagIds);
      const savedIds = normalizeTagIds(response?.tag_ids ?? tagIds);
      const current = this.commentary.find((item) => item.path === entry.path);
      if (current) current.tagIds = savedIds;
    } catch (error) {
      this.commentarySaveErrors.set(
        entry.path,
        error instanceof Error
          ? `Could not save tags for ${entry.name}: ${error.message}`
          : `Could not save tags for ${entry.name}.`,
      );
    } finally {
      this.commentarySavingPaths.delete(entry.path);
      this.#refreshCommentarySuggestData({ refreshMedia: false });
      this.#renderCommentary();
    }
  }

  #toggleCommentaryPlayback(entry) {
    if (this.commentaryPlayingPath === entry.path) {
      this.commentaryStatus.set(entry.path, "Stopped");
      this.#stopCommentaryPlayback();
      this.#renderCommentary();
      return;
    }
    const previousPath = this.commentaryPlayingPath;
    this.#stopCommentaryPlayback();
    if (previousPath) {
      this.commentaryStatus.set(previousPath, "Stopped");
    }
    this.commentaryPlayingPath = entry.path;
    this.commentaryAudioVolume.prepare(entry.volume);
    this.commentaryAudioVolume.apply(entry.volume);
    this.commentaryStatus.set(entry.path, "Starting playback…");
    this.commentaryAudio.src = this.api.commentaryFileUrl(entry.path);
    this.commentaryAudio.play()
      .then(() => {
        if (this.commentaryPlayingPath === entry.path) {
          this.commentaryStatus.set(entry.path, "Playing");
          this.#renderCommentary();
        }
      })
      .catch(() => {
        if (this.commentaryPlayingPath === entry.path) {
          this.#finishCommentaryPlayback("Playback could not be started.");
        }
      });
    this.#renderCommentary();
  }

  #stopCommentaryPlayback() {
    const path = this.commentaryPlayingPath;
    this.commentaryPlayingPath = null;
    this.commentaryAudio.pause();
    this.commentaryAudio.removeAttribute("src");
    this.commentaryAudio.load();
    return path;
  }

  #finishCommentaryPlayback(status) {
    const path = this.commentaryPlayingPath;
    if (!path) return;
    this.commentaryStatus.set(path, status);
    this.#stopCommentaryPlayback();
    this.#renderCommentary();
  }

  #storeCommentaryDuration() {
    if (
      this.commentaryPlayingPath &&
      Number.isFinite(this.commentaryAudio.duration)
    ) {
      this.commentaryDurations.set(this.commentaryPlayingPath, this.commentaryAudio.duration);
      this.#renderCommentary();
    }
  }

  #formatCommentaryDuration(duration) {
    const seconds = Math.max(0, Math.round(duration));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  #disposeCommentaryAudio() {
    this.#stopCommentaryPlayback();
    this.commentaryAudio.removeEventListener("ended", this.commentaryAudioHandlers.ended);
    this.commentaryAudio.removeEventListener("error", this.commentaryAudioHandlers.error);
    this.commentaryAudio.removeEventListener("loadedmetadata", this.commentaryAudioHandlers.loadedmetadata);
    this.commentaryAudioVolume.dispose();
  }

  async #detectXr() {
    if (!window.isSecureContext) {
      this.elements.support.textContent =
        "HTTPS is required on Quest. Trust the Souvenir certificate first.";
      this.xrSupported = false;
      this.#updateLaunchAvailability();
      return;
    }
    if (!navigator.xr) {
      this.elements.support.textContent =
        "Immersive AR is unavailable here. You can still use desktop preview.";
      this.xrSupported = false;
      this.#updateLaunchAvailability();
      return;
    }
    try {
      const supported = await navigator.xr.isSessionSupported("immersive-ar");
      this.xrSupported = supported;
      this.#updateLaunchAvailability();
      this.elements.support.textContent = supported
        ? "Quest passthrough and hand tracking are ready."
        : "This browser does not offer immersive AR. Try desktop preview.";
    } catch (error) {
      this.xrSupported = false;
      this.#updateLaunchAvailability();
      this.elements.support.textContent = "WebXR capability could not be checked.";
      this.#showError(error);
    }
  }

  #persist() {
    this.settings = saveSettings(this.storage, this.settings);
  }

  #canonicalDirectoryPaths(paths) {
    const requested = new Set(paths);
    const ordered = [];
    const seen = new Set();
    for (const directory of this.directoryHierarchy.nodes) {
      if (requested.has(directory.path) && !seen.has(directory.path)) {
        seen.add(directory.path);
        ordered.push(directory.path);
      }
    }
    return ordered;
  }

  #setDirectorySelection(directory, selected) {
    const selection = new Set(this.settings.mediaDirectories);
    for (const path of selectableDirectoryPaths(directory)) {
      if (selected) {
        selection.add(path);
      } else {
        selection.delete(path);
      }
    }
    this.settings.mediaDirectories = this.#canonicalDirectoryPaths(selection);
    this.tagPreviewResolver.invalidate();
    this.#refreshCommentarySuggestData({ refreshMedia: true });
    this.#renderTags();
  }

  #updateLaunchAvailability() {
    this.elements.preview.disabled = !this.libraryReady;
    this.elements.upload.disabled = !this.libraryReady || this.uploadInProgress;
    this.elements.browse.disabled = !this.libraryReady;
    this.elements.tagging.disabled = !this.libraryReady;
    this.elements.launch.disabled = !this.libraryReady || !this.xrSupported;
  }

  async openBrowse() {
    if (!this.libraryReady) return;
    try {
      if (!this.browseController) {
        const { BrowseController } = await import("./browse-controller.js");
        this.browseController = new BrowseController(this.document, {
          api: this.api,
          selectedDirectories: () => [...this.settings.mediaDirectories],
          tagDefinitions: () => this.#orderedTags(),
          onClose: () => {
            this.elements.home.hidden = false;
          },
          onError: (error) => this.#showError(error),
        });
      }
      this.elements.home.hidden = true;
      await this.browseController.open();
    } catch (error) {
      this.elements.home.hidden = false;
      this.document.querySelector("#browse-shell").hidden = true;
      this.#showError(error);
    }
  }

  async openTagging() {
    if (!this.libraryReady) return;
    try {
      if (!this.taggingController) {
        const { TaggingController } = await import("./tagging-controller.js");
        this.taggingController = new TaggingController(this.document, {
          api: this.api,
          selectedDirectories: () => [...this.settings.mediaDirectories],
          tagDefinitions: () => this.#orderedTags(),
          commentaryEntries: () => this.commentary.map((entry) => ({ ...entry, tagIds: [...entry.tagIds] })),
          commentaryAvailable: () => this.commentaryAvailable === true,
          onClose: () => {
            this.elements.home.hidden = false;
          },
          onError: (error) => this.#showError(error),
        });
      }
      this.elements.home.hidden = true;
      await this.taggingController.open();
    } catch (error) {
      this.elements.home.hidden = false;
      this.document.querySelector("#tagging-shell").hidden = true;
      this.#showError(error);
    }
  }

  async openScene(immersive) {
    if (!this.libraryReady) {
      return;
    }
    try {
      const selectedSceneId = this.selectedSceneId;
      if (!this.spatialApp) {
        this.spatialApp = new SpatialApp({
          canvas: this.elements.canvas,
          api: this.api,
          settings: () => this.settings,
          storage: this.storage,
          libraryId: this.libraryId,
          onExit: () => this.closeScene(),
          onError: (error) => this.#showError(error),
          onSceneStateChange: (state) => {
            this.sceneUiState = state;
            this.selectedSceneId = state.id;
            this.#renderSceneControls();
          },
        });
        if (new URLSearchParams(window.location.search).has("debug")) {
          window.__souvenirApp = this.spatialApp;
        }
      }
      this.elements.home.hidden = true;
      this.elements.sceneShell.hidden = false;
      this.elements.sceneHud.append(this.elements.sceneControls);
      await this.spatialApp.start({ immersive });
      this.sceneUiState = selectedSceneId
        ? await this.spatialApp.loadScene(selectedSceneId)
        : this.spatialApp.getSceneState();
      await this.#refreshSceneList();
      this.#renderSceneControls();
    } catch (error) {
      this.elements.sceneControlsHome.append(this.elements.sceneControls);
      this.elements.home.hidden = false;
      this.elements.sceneShell.hidden = true;
      this.#showError(error);
    }
  }

  closeScene() {
    this.spatialApp?.stop();
    this.elements.sceneControlsHome.append(this.elements.sceneControls);
    this.elements.sceneShell.hidden = true;
    if (this.sceneNoticeTimer !== null) {
      clearTimeout(this.sceneNoticeTimer);
      this.sceneNoticeTimer = null;
    }
    this.elements.sceneNotice.hidden = true;
    this.elements.home.hidden = false;
  }

  #renderSceneControls() {
    const sceneState = this.sceneUiState;
    const sceneSelect = this.elements.sceneSelect;
    sceneSelect.replaceChildren();
    const draftOption = this.document.createElement("option");
    draftOption.value = "";
    draftOption.textContent = "New scene";
    sceneSelect.append(draftOption);
    for (const scene of this.sceneList) {
      const option = this.document.createElement("option");
      option.value = scene.id;
      option.textContent = scene.name;
      sceneSelect.append(option);
    }
    sceneSelect.value = this.selectedSceneId ?? "";

    const shotSelect = this.elements.sceneShotSelect;
    shotSelect.replaceChildren();
    const none = this.document.createElement("option");
    none.value = "";
    none.textContent = "None";
    shotSelect.append(none);
    (sceneState?.shots ?? []).forEach((shot, index) => {
      const option = this.document.createElement("option");
      option.value = String(index);
      option.textContent = `Shot ${index + 1}`;
      shotSelect.append(option);
    });
    shotSelect.value = sceneState && sceneState.selected_shot_index >= 0
      ? String(sceneState.selected_shot_index)
      : "";
    this.elements.sceneLoopMode.value = sceneState?.loop === false ? "stop" : "loop";
    this.elements.scenePlaybackToggle.textContent = sceneState?.playback_active ? "Stop" : "Play";
    const duration = sceneState?.selected_shot_duration_sec ?? 8;
    this.elements.sceneDuration.value = String(duration);
    this.elements.sceneDurationValue.textContent = `${duration} sec`;
    this.elements.sceneCaptureDelete.textContent = sceneState?.can_delete_selected_shot
      ? "Delete shot"
      : "Capture shot";
    const spatialActive = Boolean(this.spatialApp?.running);
    this.elements.scenePlaybackToggle.disabled = !spatialActive || (sceneState?.shots.length ?? 0) === 0;
    this.elements.sceneCaptureDelete.disabled = !spatialActive;
  }

  async #refreshSceneList() {
    const payload = await this.api.scenes();
    this.sceneList = Array.isArray(payload?.scenes) ? payload.scenes : [];
    this.#renderSceneControls();
  }

  async #createScene() {
    const name = this.elements.sceneCreateName.value.trim();
    if (!name) return;
    if (this.spatialApp?.running) {
      this.sceneUiState = await this.spatialApp.createNamedScene(name);
    } else {
      const created = createScene(await this.api.createScene(name));
      const draft = createScene({
        ...created,
        ...sceneShotPayload(this.sceneUiState),
        id: created.id,
        name: created.name,
      });
      this.sceneUiState = this.#toSceneUiState(
        createScene(await this.api.saveScene(created.id, sceneShotPayload(draft))),
      );
    }
    this.selectedSceneId = this.sceneUiState.id;
    this.elements.sceneCreateName.value = "";
    await this.#refreshSceneList();
    this.#renderSceneControls();
  }

  async #selectSceneFromUi() {
    const sceneId = this.elements.sceneSelect.value;
    this.selectedSceneId = sceneId || null;
    if (!sceneId) {
      this.sceneUiState = this.spatialApp?.running
        ? this.spatialApp.resetToNewScene()
        : this.#toSceneUiState(createScene({ id: null, name: "New scene", loop: true }));
      this.#renderSceneControls();
      return;
    }
    this.sceneUiState = this.spatialApp?.running
      ? await this.spatialApp.loadScene(sceneId)
      : this.#toSceneUiState(createScene(await this.api.scene(sceneId)));
    this.#renderSceneControls();
  }

  async #toggleScenePlayback() {
    if (!this.spatialApp) return;
    this.sceneUiState = await this.spatialApp.toggleScenePlayback();
    this.#renderSceneControls();
  }

  async #selectSceneShotFromUi() {
    if (!this.elements.sceneShotSelect.value) return;
    const index = Number(this.elements.sceneShotSelect.value);
    if (this.spatialApp?.running) {
      this.sceneUiState = await this.spatialApp.selectSceneShot(index);
    } else {
      const shot = this.sceneUiState.shots[index];
      if (!shot) return;
      const next = createScene({ ...this.sceneUiState, current_shot_id: shot.id });
      this.sceneUiState = await this.#saveHomeScene(next);
    }
    this.#renderSceneControls();
  }

  async #setSceneLoopMode() {
    const loop = this.elements.sceneLoopMode.value === "loop";
    this.sceneUiState = this.spatialApp?.running
      ? await this.spatialApp.setSceneLoop(loop)
      : await this.#saveHomeScene(createScene({ ...this.sceneUiState, loop }));
    this.#renderSceneControls();
  }

  async #setSceneDurationFromUi() {
    const duration = Number(this.elements.sceneDuration.value);
    if (this.spatialApp?.running) {
      this.sceneUiState = await this.spatialApp.setSceneShotDuration(duration);
    } else {
      const selectedIndex = this.sceneUiState.shots.findIndex(
        (shot) => shot.id === this.sceneUiState.current_shot_id,
      );
      const next = selectedIndex < 0
        ? createScene({ ...this.sceneUiState, default_duration_sec: duration })
        : createScene({
          ...this.sceneUiState,
          shots: this.sceneUiState.shots.map((shot, index) => (
            index === selectedIndex ? { ...shot, duration_sec: duration } : shot
          )),
        });
      this.sceneUiState = await this.#saveHomeScene(next);
    }
    this.#renderSceneControls();
  }

  async #captureOrDeleteSceneShot() {
    if (!this.spatialApp) return;
    this.sceneUiState = await this.spatialApp.captureOrDeleteSceneShot();
    this.#renderSceneControls();
  }

  async #saveHomeScene(scene) {
    if (!scene.id) return this.#toSceneUiState(scene);
    return this.#toSceneUiState(createScene(
      await this.api.saveScene(scene.id, sceneShotPayload(scene)),
    ));
  }

  #toSceneUiState(scene) {
    const selectedIndex = scene.shots.findIndex((shot) => shot.id === scene.current_shot_id);
    return {
      ...scene,
      selected_shot_index: selectedIndex,
      selected_shot_duration_sec: selectedIndex >= 0
        ? scene.shots[selectedIndex].duration_sec
        : scene.default_duration_sec,
      playback_active: false,
      can_delete_selected_shot: false,
    };
  }

  #showError(error) {
    const message =
      error instanceof Error ? error.message : "An unexpected Souvenir error occurred.";
    this.elements.error.textContent = message;
    this.elements.error.hidden = false;
    if (!this.elements.sceneShell.hidden) {
      this.elements.sceneNotice.textContent = message;
      this.elements.sceneNotice.hidden = false;
      if (this.sceneNoticeTimer !== null) {
        clearTimeout(this.sceneNoticeTimer);
      }
      this.sceneNoticeTimer = setTimeout(() => {
        this.sceneNoticeTimer = null;
        this.elements.sceneNotice.hidden = true;
      }, 6000);
    }
  }
}

export { DEFAULT_SETTINGS };
