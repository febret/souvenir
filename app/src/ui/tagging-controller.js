import { isVideo, normalizeMediaEntry } from "../core/media.js";
import { normalizeTagDefinitions } from "../core/tags.js";

const GRID_SIZE = 9;

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "00:00.0";
  }
  const totalTenths = Math.floor(ms / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

export class TaggingController {
  constructor(document, {
    api,
    selectedDirectories,
    tagDefinitions,
    commentaryEntries = () => [],
    commentaryAvailable = () => false,
    onClose,
    onError,
  }) {
    this.document = document;
    this.api = api;
    this.selectedDirectories = selectedDirectories;
    this.tagDefinitions = tagDefinitions;
    this.commentaryEntries = commentaryEntries;
    this.commentaryAvailable = commentaryAvailable;
    this.onClose = onClose;
    this.onError = onError;

    this.allFiles = [];
    this.gridFiles = [];
    this.tagQueue = [];
    this.currentTagIndex = 0;
    this.saving = false;
    this.loadGeneration = 0;

    this.totalPoolSize = 0;
    this.processedCount = 0;
    this.sessionScore = 0;
    this.bestTagMs = null;
    this.bestSetMs = null;
    this.previousTagMs = null;
    this.comboCount = 1;
    this.bestComboCount = 1;
    this.commentaryEnabled = false;
    this.commentaryPlayingPath = null;
    this.commentary = [];
    this.usedCommentaryPaths = new Set();
    this.tagActions = 0;
    this.tagStartedAt = 0;
    this.batchStartedAt = 0;
    this.tickerId = null;
    this.comboBannerTimerId = null;
    this.sessionRecordsBroken = 0;

    this.elements = {
      shell: document.querySelector("#tagging-shell"),
      exit: document.querySelector("#exit-tagging"),
      continueBtn: document.querySelector("#tagging-continue"),
      confirmExitBtn: document.querySelector("#tagging-confirm-exit"),
      exitSummary: document.querySelector("#tagging-exit-summary"),
      flash: document.querySelector("#tagging-flash"),
      fxLayer: document.querySelector("#tagging-fx-layer"),
      finalScore: document.querySelector("#tagging-final-score"),
      finalRecords: document.querySelector("#tagging-final-records"),
      combo: document.querySelector("#tagging-combo"),
      commentaryToggle: document.querySelector("#tagging-commentary-enabled"),
      commentaryState: document.querySelector("#tagging-commentary-state"),
      comboBanner: document.querySelector("#tagging-combo-banner"),
      comboMultiplier: document.querySelector("#tagging-combo-multiplier"),
      comboText: document.querySelector("#tagging-combo-text"),
      remainingPanel: document.querySelector(".tagging-remaining-panel"),
      remainingText: document.querySelector("#tagging-remaining-text"),
      remainingFill: document.querySelector("#tagging-remaining-fill"),
      tagTimer: document.querySelector("#tagging-tag-timer"),
      setTimer: document.querySelector("#tagging-set-timer"),
      bestTag: document.querySelector("#tagging-best-tag"),
      bestSet: document.querySelector("#tagging-best-set"),
      score: document.querySelector("#tagging-score"),
      scoreCard: document.querySelector(".tagging-stat-card--score"),
      tagInfo: document.querySelector("#tagging-tag-info"),
      tagLabel: document.querySelector("#tagging-tag-label"),
      tagProgress: document.querySelector("#tagging-tag-progress"),
      grid: document.querySelector("#tagging-grid"),
      nextBtn: document.querySelector("#tagging-next"),
      status: document.querySelector("#tagging-status"),
      roundBadge: document.querySelector("#tagging-round-badge"),
      progressBar: document.querySelector("#tagging-progress-fill"),
    };

    this.commentaryAudio = document.createElement("audio");
    this.commentaryAudio.preload = "metadata";
    this.commentaryAudio.addEventListener("ended", () => {
      this.commentaryPlayingPath = null;
      this.#refreshCommentaryUi();
      void this.#queueNextCommentary();
    });
    this.commentaryAudio.addEventListener("error", () => {
      this.commentaryPlayingPath = null;
      this.#refreshCommentaryUi();
      void this.#queueNextCommentary();
    });

    this.handleKeydown = (event) => {
      if (
        event.key !== " "
        && event.code !== "Space"
        && event.key !== "Spacebar"
      ) {
        return;
      }
      if (this.elements.shell.hidden || this.elements.nextBtn.disabled) {
        return;
      }
      const active = this.document.activeElement;
      if (
        active instanceof HTMLInputElement
        || active instanceof HTMLTextAreaElement
        || active instanceof HTMLSelectElement
        || active?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      this.#nextTag();
    };

    this.#bindEvents();
  }

  #bindEvents() {
    this.elements.exit.addEventListener("click", () => this.#openExitSummary());
    this.elements.continueBtn.addEventListener("click", () => this.#hideExitSummary());
    this.elements.confirmExitBtn.addEventListener("click", () => this.close());
    this.elements.nextBtn.addEventListener("click", () => this.#nextTag());
    this.elements.commentaryToggle.addEventListener("change", () => {
      this.#setCommentaryEnabled(this.elements.commentaryToggle.checked);
    });
    this.document.addEventListener("keydown", this.handleKeydown);
  }

  async open() {
    this.elements.shell.hidden = false;
    this.elements.shell.inert = false;
    this.#hideExitSummary();
    this.#resetSessionStats();
    this.#startTicker();
    this.elements.exit.focus();
    await this.#loadAndStart();
  }

  close() {
    this.#stopTicker();
    if (this.comboBannerTimerId != null) {
      window.clearTimeout(this.comboBannerTimerId);
      this.comboBannerTimerId = null;
    }
    this.elements.shell.hidden = true;
    this.elements.shell.inert = true;
    this.#hideExitSummary();
    this.elements.comboBanner.hidden = true;
    this.#stopCommentaryPlayback();
    this.elements.grid.querySelectorAll("video").forEach((video) => video.pause());
    this.onClose();
  }

  #resetSessionStats() {
    this.totalPoolSize = 0;
    this.processedCount = 0;
    this.sessionScore = 0;
    this.bestTagMs = null;
    this.bestSetMs = null;
    this.previousTagMs = null;
    this.comboCount = 1;
    this.bestComboCount = 1;
    this.commentaryEnabled = false;
    this.commentaryPlayingPath = null;
    this.commentary = [];
    this.usedCommentaryPaths.clear();
    this.tagActions = 0;
    this.tagStartedAt = 0;
    this.batchStartedAt = 0;
    this.sessionRecordsBroken = 0;
    this.#renderRecords();
    this.#renderCombo();
    this.#renderScore();
    this.#renderTimers();
    this.#renderRemainingProgress();
    this.#refreshCommentaryUi();
  }

  #startTicker() {
    this.#stopTicker();
    this.tickerId = window.setInterval(() => this.#renderTimers(), 100);
  }

  #stopTicker() {
    if (this.tickerId != null) {
      window.clearInterval(this.tickerId);
      this.tickerId = null;
    }
  }

  async #loadAndStart() {
    this.loadGeneration += 1;
    const generation = this.loadGeneration;
    this.#setStatus("Loading your library…");
    this.elements.nextBtn.disabled = true;

    try {
      const dirs = this.selectedDirectories();
      if (!dirs.length) {
        this.#setStatus("No folders selected. Go back and select some folders first.");
        this.elements.tagLabel.textContent = "No folders selected";
        this.elements.tagProgress.textContent = "";
        return;
      }

      const allEntries = await this.#loadAllFiles(dirs);
      if (generation !== this.loadGeneration) {
        return;
      }

      if (allEntries.length === 0) {
        this.#setStatus("No media files found in the selected folders.");
        this.elements.tagLabel.textContent = "No files found";
        this.elements.tagProgress.textContent = "";
        return;
      }

      const tags = normalizeTagDefinitions(this.tagDefinitions());
      if (tags.length === 0) {
        this.#setStatus("No tags defined yet. Create some tags on the home screen first.");
        this.elements.tagLabel.textContent = "No tags yet";
        this.elements.tagProgress.textContent = "";
        return;
      }

      this.allFiles = allEntries.sort((left, right) => {
        const leftCount = (left.tag_ids ?? []).length;
        const rightCount = (right.tag_ids ?? []).length;
        return leftCount !== rightCount ? leftCount - rightCount : Math.random() - 0.5;
      });
      this.totalPoolSize = this.allFiles.length;
      this.processedCount = 0;

      this.#pickGrid();
      this.tagQueue = tags;
      this.commentary = this.commentaryAvailable() ? this.commentaryEntries() : [];
      this.currentTagIndex = 0;
      this.batchStartedAt = Date.now();
      this.tagStartedAt = Date.now();
      this.tagActions = 0;
      this.usedCommentaryPaths.clear();

      this.#renderRound();
      this.#renderTag();
      this.#renderGrid();
      this.#renderTimers();
      this.#renderRemainingProgress();
      this.#setStatus("");
      this.elements.nextBtn.disabled = false;
    } catch (error) {
      this.onError(error);
    }
  }

  async #loadAllFiles(dirs) {
    const results = await Promise.all(
      dirs.map((dir) => this.api.directory(dir, dirs)),
    );
    const allEntries = [];
    const seen = new Set();
    for (const result of results) {
      for (const entry of result.files ?? []) {
        const normalized = normalizeMediaEntry(entry);
        if (!seen.has(normalized.path)) {
          seen.add(normalized.path);
          allEntries.push(normalized);
        }
      }
    }
    return allEntries;
  }

  #pickGrid() {
    this.gridFiles = this.allFiles.slice(0, GRID_SIZE).map((file) => ({
      ...file,
      sessionTagIds: new Set(file.tag_ids ?? []),
    }));
  }

  get #currentTag() {
    return this.tagQueue[this.currentTagIndex] ?? null;
  }

  #renderRound() {
    const remaining = this.allFiles.length;
    this.elements.roundBadge.textContent = remaining > 0
      ? `${remaining} file${remaining !== 1 ? "s" : ""} remaining`
      : "Last batch!";
  }

  #renderTag() {
    const tag = this.#currentTag;
    if (!tag) {
      this.elements.tagLabel.textContent = "All tags done!";
      this.elements.tagProgress.textContent = "";
      this.elements.progressBar.style.width = "100%";
      this.elements.nextBtn.textContent = "New batch →";
      this.#renderTagBackground(null);
      return;
    }
    this.elements.tagLabel.textContent = tag.name;
    this.elements.tagProgress.textContent = `Tag ${this.currentTagIndex + 1} of ${this.tagQueue.length}`;
    const pct = this.tagQueue.length > 0
      ? Math.round((this.currentTagIndex / this.tagQueue.length) * 100)
      : 0;
    this.elements.progressBar.style.width = `${pct}%`;
    this.elements.nextBtn.textContent = "Next tag →";
    this.#renderTagBackground(tag);
    this.#refreshCommentaryUi();
    void this.#queueNextCommentary();
  }

  #renderTagBackground(tag) {
    const panel = this.elements.tagInfo;
    if (!panel || !tag?.id) {
      panel?.classList.add("tagging-tag-info--no-image");
      panel?.style.removeProperty("--tag-bg-image");
      return;
    }

    const imageCandidates = this.allFiles.filter((file) =>
      !isVideo(file) && Array.isArray(file.tag_ids) && file.tag_ids.includes(tag.id));
    const candidate = imageCandidates.length > 0
      ? imageCandidates[this.currentTagIndex % imageCandidates.length]
      : null;
    if (!candidate) {
      panel.classList.add("tagging-tag-info--no-image");
      panel.style.removeProperty("--tag-bg-image");
      return;
    }

    panel.classList.remove("tagging-tag-info--no-image");
    panel.style.setProperty("--tag-bg-image", `url("${this.api.thumbnailUrl(candidate.path)}")`);
  }

  #renderRemainingProgress() {
    const remaining = this.allFiles.length;
    this.elements.remainingText.textContent = `${remaining} image${remaining !== 1 ? "s" : ""} remaining`;
    const complete = this.totalPoolSize > 0
      ? Math.round((this.processedCount / this.totalPoolSize) * 100)
      : 0;
    this.elements.remainingFill.style.width = `${complete}%`;

    const panel = this.elements.remainingPanel;
    panel.classList.remove("tagging-remaining-panel--warm", "tagging-remaining-panel--hot", "tagging-remaining-panel--nuclear");
    if (remaining <= 6 && remaining > 3) {
      panel.classList.add("tagging-remaining-panel--warm");
    } else if (remaining <= 3 && remaining > 1) {
      panel.classList.add("tagging-remaining-panel--hot");
    } else if (remaining <= 1) {
      panel.classList.add("tagging-remaining-panel--nuclear");
    }
  }

  #renderTimers() {
    const now = Date.now();
    this.elements.tagTimer.textContent = this.tagStartedAt ? formatDuration(now - this.tagStartedAt) : "00:00.0";
    this.elements.setTimer.textContent = this.batchStartedAt ? formatDuration(now - this.batchStartedAt) : "00:00.0";
  }

  #renderRecords() {
    this.elements.bestTag.textContent = this.bestTagMs == null ? "--" : formatDuration(this.bestTagMs);
    this.elements.bestSet.textContent = this.bestSetMs == null ? "--" : formatDuration(this.bestSetMs);
  }

  #renderScore() {
    this.elements.score.textContent = String(this.sessionScore);
  }

  #refreshCommentaryUi() {
    const available = this.commentaryAvailable() && this.commentary.length > 0;
    this.elements.commentaryToggle.disabled = !available;
    this.elements.commentaryToggle.checked = available && this.commentaryEnabled;
    if (!available) {
      this.elements.commentaryState.textContent = "Unavailable";
      return;
    }
    if (!this.commentaryEnabled) {
      this.elements.commentaryState.textContent = "Off";
      return;
    }
    if (this.commentaryPlayingPath) {
      this.elements.commentaryState.textContent = this.commentaryPlayingPath.split("/").at(-1) ?? "Playing";
      return;
    }
    const currentTagName = this.#currentTag?.name;
    this.elements.commentaryState.textContent = currentTagName ? `Ready for ${currentTagName}` : "Waiting";
  }

  #stopCommentaryPlayback() {
    this.commentaryAudio.pause();
    this.commentaryAudio.removeAttribute("src");
    this.commentaryAudio.load();
    this.commentaryPlayingPath = null;
    this.#refreshCommentaryUi();
  }

  #setCommentaryEnabled(enabled) {
    const available = this.commentaryAvailable() && this.commentary.length > 0;
    this.commentaryEnabled = Boolean(enabled && available);
    if (!this.commentaryEnabled) {
      this.#stopCommentaryPlayback();
      return;
    }
    this.#refreshCommentaryUi();
    void this.#queueNextCommentary();
  }

  #selectCommentaryForCurrentTag() {
    const currentTagId = this.#currentTag?.id;
    if (!currentTagId) {
      return null;
    }
    const exactMatches = this.commentary.filter((entry) =>
      Array.isArray(entry.tagIds) && entry.tagIds.includes(currentTagId) && !this.usedCommentaryPaths.has(entry.path));
    if (exactMatches.length === 0) {
      return null;
    }
    return [...exactMatches].sort((left, right) => {
      const leftTagCount = Array.isArray(left.tagIds) ? left.tagIds.length : 0;
      const rightTagCount = Array.isArray(right.tagIds) ? right.tagIds.length : 0;
      return leftTagCount - rightTagCount || left.path.localeCompare(right.path);
    })[0];
  }

  async #queueNextCommentary() {
    if (!this.commentaryEnabled || this.commentaryPlayingPath) {
      return;
    }
    const nextEntry = this.#selectCommentaryForCurrentTag();
    if (!nextEntry) {
      this.#refreshCommentaryUi();
      return;
    }
    this.usedCommentaryPaths.add(nextEntry.path);
    this.commentaryPlayingPath = nextEntry.path;
    this.commentaryAudio.src = this.api.commentaryFileUrl(nextEntry.path);
    this.commentaryAudio.volume = Number.isFinite(nextEntry.volume) ? nextEntry.volume : 1;
    this.#refreshCommentaryUi();
    try {
      await this.commentaryAudio.play();
    } catch {
      this.commentaryPlayingPath = null;
      this.#refreshCommentaryUi();
    }
  }

  #renderCombo() {
    this.elements.combo.textContent = `x${this.comboCount}`;
    this.elements.combo.parentElement?.classList.toggle("tagging-stat-card--combo-live", this.comboCount >= 2);
  }

  #comboLabel(count) {
    if (count >= 10) return "ABSOLUTE MAYHEM";
    if (count >= 8) return "GODLIKE";
    if (count >= 7) return "MONSTER";
    if (count >= 6) return "ULTRA";
    if (count >= 5) return "UNSTOPPABLE";
    if (count >= 4) return "DEVASTATING";
    if (count >= 3) return "DOMINATING";
    return "COMBO";
  }

  #showComboBanner(count) {
    const banner = this.elements.comboBanner;
    banner.hidden = false;
    banner.className = "tagging-combo-banner";
    const tier = Math.min(5, Math.max(2, count));
    banner.classList.add(`tagging-combo-banner--tier-${tier}`);
    this.elements.comboMultiplier.textContent = `x${count}`;
    this.elements.comboText.textContent = this.#comboLabel(count);
    void banner.offsetWidth;
    banner.classList.add("tagging-combo-banner--show");
    if (this.comboBannerTimerId != null) {
      window.clearTimeout(this.comboBannerTimerId);
    }
    this.comboBannerTimerId = window.setTimeout(() => {
      banner.classList.remove("tagging-combo-banner--show");
      banner.hidden = true;
      this.comboBannerTimerId = null;
    }, 980);
  }

  #registerCombo(elapsed) {
    if (this.previousTagMs == null) {
      this.previousTagMs = elapsed;
      this.comboCount = 1;
      this.#renderCombo();
      return 0;
    }
    let bonus = 0;
    if (elapsed < this.previousTagMs) {
      this.comboCount = this.comboCount >= 2 ? this.comboCount + 1 : 2;
      this.bestComboCount = Math.max(this.bestComboCount, this.comboCount);
      this.#renderCombo();
      this.#showComboBanner(this.comboCount);
      this.#playImpact(this.comboCount >= 5 ? "set" : "tag");
      this.#spawnParticles({ count: Math.min(16 + this.comboCount * 4, 44), intense: this.comboCount >= 5 });
      bonus = this.comboCount * 60;
    } else {
      this.comboCount = 1;
      this.#renderCombo();
    }
    this.previousTagMs = elapsed;
    return bonus;
  }

  #playImpact(level = "tag") {
    const shellClass = level === "set"
      ? "tagging-shell--super-impact"
      : "tagging-shell--impact";
    const flashClass = level === "set"
      ? "tagging-flash--super"
      : "tagging-flash--tag";
    this.elements.shell.classList.remove("tagging-shell--impact", "tagging-shell--super-impact");
    this.elements.flash.classList.remove("tagging-flash--tag", "tagging-flash--super");
    void this.elements.shell.offsetWidth;
    this.elements.shell.classList.add(shellClass);
    this.elements.flash.classList.add(flashClass);
    window.setTimeout(() => {
      this.elements.shell.classList.remove(shellClass);
      this.elements.flash.classList.remove(flashClass);
    }, level === "set" ? 650 : 360);
  }

  #spawnParticles({ count, intense = false } = {}) {
    const layer = this.elements.fxLayer;
    for (let index = 0; index < count; index += 1) {
      const particle = this.document.createElement("span");
      particle.className = intense
        ? "tagging-particle tagging-particle--set"
        : "tagging-particle tagging-particle--tag";
      particle.style.setProperty("--x", `${(Math.random() * 100).toFixed(2)}%`);
      particle.style.setProperty("--y", `${(20 + Math.random() * 60).toFixed(2)}%`);
      particle.style.setProperty("--dx", `${(-220 + Math.random() * 440).toFixed(0)}px`);
      particle.style.setProperty("--dy", `${(-180 - Math.random() * 220).toFixed(0)}px`);
      particle.style.setProperty("--size", `${(intense ? 8 : 5) + Math.random() * (intense ? 16 : 9)}px`);
      particle.style.setProperty("--delay", `${(Math.random() * 90).toFixed(0)}ms`);
      layer.appendChild(particle);
      particle.addEventListener("animationend", () => particle.remove(), { once: true });
    }
  }

  #celebrateRecord(kind) {
    this.sessionRecordsBroken += 1;
    const target = kind === "tag" ? this.elements.bestTag : this.elements.bestSet;
    target.classList.add("tagging-record-break");
    target.addEventListener("animationend", () => target.classList.remove("tagging-record-break"), { once: true });
    this.elements.shell.classList.add("tagging-shell--record-burst");
    window.setTimeout(() => this.elements.shell.classList.remove("tagging-shell--record-burst"), 520);
  }

  #awardPoints(points, reason) {
    this.sessionScore += Math.max(0, points);
    this.#renderScore();
    this.elements.scoreCard.classList.add("tagging-score-pop");
    this.elements.scoreCard.addEventListener("animationend", () => {
      this.elements.scoreCard.classList.remove("tagging-score-pop");
    }, { once: true });
    this.#setStatus(`+${points} points · ${reason}`);
  }

  #finalizeTagAttempt() {
    if (!this.#currentTag || !this.tagStartedAt) {
      return;
    }
    const elapsed = Date.now() - this.tagStartedAt;
    let points = Math.max(40, Math.round(24000 / Math.max(elapsed, 450)));
    points += this.tagActions * 6;
    points += this.#registerCombo(elapsed);
    let message = "Tag completed";
    if (this.bestTagMs == null || elapsed < this.bestTagMs) {
      this.bestTagMs = elapsed;
      this.#renderRecords();
      this.#celebrateRecord("tag");
      points += 250;
      message = "New best tag time!";
    }
    if (this.comboCount < 2) {
      this.#playImpact("tag");
      this.#spawnParticles({ count: 18 });
    }
    this.#awardPoints(points, message);
  }

  #openExitSummary() {
    this.elements.finalScore.textContent = `Final score: ${this.sessionScore.toLocaleString()}`;
    this.elements.finalRecords.textContent = `Best tag: ${this.bestTagMs == null ? "--" : formatDuration(this.bestTagMs)} · Best set: ${this.bestSetMs == null ? "--" : formatDuration(this.bestSetMs)} · Records broken: ${this.sessionRecordsBroken} · Best combo: x${this.bestComboCount}`;
    this.elements.exitSummary.hidden = false;
  }

  #hideExitSummary() {
    this.elements.exitSummary.hidden = true;
  }

  #renderGrid() {
    const grid = this.elements.grid;
    const tagId = this.#currentTag?.id ?? null;

    const existing = [...grid.querySelectorAll(".tagging-cell")];
    if (existing.length > 0 && existing.length !== this.gridFiles.length) {
      existing.forEach((cell) => {
        cell.classList.add("tagging-cell--exit");
        cell.addEventListener("animationend", () => cell.remove(), { once: true });
      });
      window.setTimeout(() => this.#createCells(grid, tagId), 300);
    } else if (existing.length === 0) {
      this.#createCells(grid, tagId);
    } else {
      this.#updateCells(existing, tagId);
    }
  }

  #createCells(grid, tagId) {
    grid.innerHTML = "";
    this.gridFiles.forEach((file, index) => {
      const cell = this.#buildCell(file, tagId, index);
      grid.appendChild(cell);
    });
  }

  #updateCells(cells, tagId) {
    cells.forEach((cell, index) => {
      const file = this.gridFiles[index];
      if (!file) {
        return;
      }
      const hasTag = tagId && file.sessionTagIds.has(tagId);
      cell.classList.toggle("tagging-cell--has-tag", Boolean(hasTag));
      cell.dataset.path = file.path;
      if (tagId) {
        cell.dataset.tagId = tagId;
      } else {
        delete cell.dataset.tagId;
      }
    });
  }

  #buildCell(file, tagId, index) {
    const cell = this.document.createElement("div");
    cell.className = "tagging-cell tagging-cell--enter";
    cell.dataset.path = file.path;
    if (tagId) {
      cell.dataset.tagId = tagId;
    }
    cell.style.animationDelay = `${index * 50}ms`;

    const hasTag = tagId && file.sessionTagIds.has(tagId);
    if (hasTag) {
      cell.classList.add("tagging-cell--has-tag");
    }

    const media = isVideo(file)
      ? this.#buildVideo(file)
      : this.#buildImage(file);

    const overlay = this.document.createElement("div");
    overlay.className = "tagging-cell-overlay";
    overlay.innerHTML = "<span class=\"tagging-cell-check\" aria-hidden=\"true\">✓</span>";

    const filename = this.document.createElement("div");
    filename.className = "tagging-cell-filename";
    filename.textContent = file.path.split("/").at(-1) ?? file.path;

    cell.appendChild(media);
    cell.appendChild(overlay);
    cell.appendChild(filename);

    cell.addEventListener("click", () => this.#toggleTag(cell, file));
    cell.addEventListener("animationend", () => {
      cell.classList.remove("tagging-cell--enter");
    }, { once: true });

    return cell;
  }

  #buildImage(file) {
    const img = this.document.createElement("img");
    img.src = this.api.thumbnailUrl(file.path);
    img.alt = "";
    img.className = "tagging-media tagging-media--image";
    img.loading = "lazy";
    return img;
  }

  #buildVideo(file) {
    const video = this.document.createElement("video");
    video.src = this.api.fileUrl(file.path);
    video.className = "tagging-media";
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    return video;
  }

  #toggleTag(cell, file) {
    const tagId = cell.dataset.tagId;
    if (!tagId) {
      return;
    }
    this.tagActions += 1;

    const hadTag = file.sessionTagIds.has(tagId);
    if (hadTag) {
      file.sessionTagIds.delete(tagId);
      cell.classList.remove("tagging-cell--has-tag");
      cell.classList.add("tagging-cell--pulse");
    } else {
      file.sessionTagIds.add(tagId);
      cell.classList.add("tagging-cell--has-tag", "tagging-cell--pulse");
    }
    cell.addEventListener("animationend", () => {
      cell.classList.remove("tagging-cell--pulse");
    }, { once: true });
  }

  async #nextTag() {
    if (this.saving) {
      return;
    }
    this.#finalizeTagAttempt();

    const allDone = !this.#currentTag || this.currentTagIndex >= this.tagQueue.length - 1;
    if (allDone) {
      await this.#saveAndAdvance();
      return;
    }

    this.currentTagIndex += 1;
    this.tagStartedAt = Date.now();
    this.tagActions = 0;
    const tagId = this.#currentTag?.id ?? null;

    this.#renderTag();
    this.elements.tagLabel.classList.add("tagging-tag--flash");
    this.elements.tagLabel.addEventListener("animationend", () => {
      this.elements.tagLabel.classList.remove("tagging-tag--flash");
    }, { once: true });

    const cells = [...this.elements.grid.querySelectorAll(".tagging-cell")];
    this.#updateCells(cells, tagId);
    cells.forEach((cell, index) => {
      window.setTimeout(() => {
        cell.classList.add("tagging-cell--flip");
        cell.addEventListener("animationend", () => {
          cell.classList.remove("tagging-cell--flip");
        }, { once: true });
      }, index * 30);
    });
  }

  async #saveAndAdvance() {
    this.saving = true;
    this.elements.nextBtn.disabled = true;
    this.#setStatus("Saving tags…");

    try {
      const assignments = this.gridFiles.map((file) => ({
        path: file.path,
        tag_ids: [...file.sessionTagIds],
      }));
      await this.api.saveMediaTagsBulk(assignments);

      const setElapsed = this.batchStartedAt ? Date.now() - this.batchStartedAt : 0;
      let setPoints = Math.max(120, Math.round(90000 / Math.max(setElapsed, 1000)));
      if (this.bestSetMs == null || setElapsed < this.bestSetMs) {
        this.bestSetMs = setElapsed;
        this.#renderRecords();
        this.#celebrateRecord("set");
        setPoints += 600;
      }
      this.#playImpact("set");
      this.#spawnParticles({ count: 42, intense: true });
      this.#awardPoints(setPoints, "Set completed");

      const savedPaths = new Set(this.gridFiles.map((file) => file.path));
      this.allFiles = this.allFiles.filter((file) => !savedPaths.has(file.path));
      this.processedCount = Math.min(this.totalPoolSize, this.processedCount + assignments.length);
      this.#renderRemainingProgress();

      if (this.allFiles.length === 0) {
        this.#setStatus("🎆 Clean sweep! Reloading challenge set…");
        await this.#loadAndStart();
        return;
      }

      this.#setStatus("Great work! Loading next batch…");
      const cells = [...this.elements.grid.querySelectorAll(".tagging-cell")];
      cells.forEach((cell, index) => {
        window.setTimeout(() => {
          cell.classList.add("tagging-cell--exit");
        }, index * 40);
      });

      await new Promise((resolve) => window.setTimeout(resolve, cells.length * 40 + 350));

      this.#pickGrid();
      this.currentTagIndex = 0;
      this.batchStartedAt = Date.now();
      this.tagStartedAt = Date.now();
      this.tagActions = 0;
      this.usedCommentaryPaths.clear();
      this.#renderRound();
      this.#renderTag();
      this.#createCells(this.elements.grid, this.#currentTag?.id ?? null);
      this.#setStatus("");
    } catch (error) {
      this.onError(error);
      this.#setStatus("Error saving tags.");
    } finally {
      this.saving = false;
      this.elements.nextBtn.disabled = false;
    }
  }

  #setStatus(text) {
    this.elements.status.textContent = text;
    this.elements.status.hidden = !text;
  }
}
