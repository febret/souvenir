import {
  audioBufferToWav,
  cropAudioBuffer,
  normalizeCrop,
  timeLabel,
} from "../core/audio-crop.js";
import { createTagPill } from "./tag-pill.js";

export const COMMENTARY_TTS_POLL_INTERVAL_MS = 700;
export const COMMENTARY_ADD_TEXT_LIMIT = 2000;
export const COMMENTARY_ADD_MAX_TAGS = 64;

/**
 * Owns the Add-commentary (TTS preview → trim → save) dialog.
 * HomeController stays coordinator: it passes availability/tags and
 * re-renders the commentary list after a successful save.
 */
export class CommentaryAddDialog {
  constructor({
    document,
    api,
    elements,
    getTags = () => [],
    getAvailability = () => ({ loading: false, error: "", available: false }),
    onSaved = () => {},
    onError = () => {},
  } = {}) {
    this.document = document;
    this.api = api;
    this.elements = elements;
    this.getTags = getTags;
    this.getAvailability = getAvailability;
    this.onSaved = onSaved;
    this.onError = onError;

    this.isOpen = false;
    this.loadingVoices = false;
    this.voices = [];
    this.voiceFilter = "";
    this._voiceOptionsSignature = null;
    this.text = "";
    this.voice = "";
    this.pitch = 0;
    this.rate = 0;
    this.error = "";
    this.requestId = null;
    this.ttsUrl = null;
    this.pollTimer = null;
    this.status = "";
    this.duration = 0;
    this.cropStart = 0;
    this.cropEnd = 0;
    this.tagIds = new Set();
    this.saving = false;
    this.saveStatus = "";
    this.previewPlaying = false;

    this.previewAudio = document.createElement("audio");
    this.previewAudio.preload = "metadata";
    this.handlers = {
      play: () => {
        this.previewPlaying = true;
        this.status = "Playing preview…";
        this.render();
      },
      pause: () => {
        this.previewPlaying = false;
        this.render();
      },
      ended: () => {
        this.previewPlaying = false;
        this.status = "Preview finished. Trim the start and end, then save.";
        this.render();
      },
      error: () => {
        this.previewPlaying = false;
        this.status = "Preview could not be loaded.";
        this.render();
      },
      loadedmetadata: () => {
        if (!Number.isFinite(this.previewAudio.duration)) return;
        this.duration = this.previewAudio.duration;
        this.cropStart = 0;
        this.cropEnd = this.previewAudio.duration;
        this.status = "Preview ready — press Replay to listen.";
        this.render();
      },
    };
    for (const [event, handler] of Object.entries(this.handlers)) {
      this.previewAudio.addEventListener(event, handler);
    }
  }

  bind() {
    const el = this.elements;
    el.addCommentary.addEventListener("click", () => this.open());
    el.commentaryAddForm.addEventListener("submit", (event) => {
      event.preventDefault();
    });
    el.commentaryAddClose.addEventListener("click", () => {
      this.close();
      this.render();
    });
    el.commentaryAddPopup.addEventListener("click", (event) => {
      if (event.target === el.commentaryAddPopup) {
        this.close();
        this.render();
      }
    });
    el.commentaryAddSave.addEventListener("click", () => {
      this.save().catch((error) => this.onError(error));
    });
    el.commentaryAddText.addEventListener("input", () => {
      this.text = el.commentaryAddText.value.slice(0, COMMENTARY_ADD_TEXT_LIMIT);
      this.render();
    });
    el.commentaryAddVoice.addEventListener("change", () => {
      this.voice = el.commentaryAddVoice.value;
      this.render();
    });
    el.commentaryAddVoiceFilter.addEventListener("input", () => {
      this.voiceFilter = el.commentaryAddVoiceFilter.value;
      this.reconcileVoiceSelection();
      this.render();
    });
    const bindTuning = (slider, apply) => {
      slider.addEventListener("input", () => {
        apply(Number(slider.value));
        this.render();
      });
    };
    bindTuning(el.commentaryAddPitch, (value) => {
      this.pitch = value;
    });
    bindTuning(el.commentaryAddRate, (value) => {
      this.rate = value;
    });
    el.commentaryAddPreview.addEventListener("click", () => {
      this.requestPreview().catch((error) => this.onError(error));
    });
    el.commentaryAddCancelTts.addEventListener("click", () => {
      this.cancelPreview().catch((error) => this.onError(error));
    });
    el.commentaryAddReplay.addEventListener("click", () => this.replay());
    const bindCrop = (slider, key) => {
      slider.addEventListener("input", () => {
        this[key] = Number(slider.value);
        if (Number.isFinite(this.previewAudio.duration)) {
          try {
            this.previewAudio.currentTime = this[key];
          } catch {
            // Seeking may throw before metadata is ready; crop values still apply.
          }
        }
        this.render();
      });
    };
    bindCrop(el.commentaryAddStart, "cropStart");
    bindCrop(el.commentaryAddEnd, "cropEnd");
  }

  disabledReason() {
    const { loading, error, available } = this.getAvailability();
    if (loading) return "Loading commentary…";
    if (error) return "Commentary is unavailable while its load is failing.";
    if (available !== true) {
      return "Commentary is not configured. Set SOUVENIR_COMMENTARY_DIR on the media server, then reload.";
    }
    return "";
  }

  busy() {
    return this.loadingVoices || Boolean(this.requestId) || this.saving;
  }

  open() {
    if (this.disabledReason()) return;
    this.reset();
    this.isOpen = true;
    this.loadVoices();
    this.render();
    if (typeof window !== "undefined" && window.requestAnimationFrame) {
      window.requestAnimationFrame(() => this.elements.commentaryAddText?.focus());
    }
  }

  close() {
    if (this.requestId) {
      this.api.cancelTts(this.requestId).catch(() => {});
    }
    this.stopPolling();
    this.stopPreview();
    this.isOpen = false;
    this.requestId = null;
    this.ttsUrl = null;
  }

  reset() {
    this.stopPolling();
    this.stopPreview();
    this.text = "";
    this.voiceFilter = "";
    this.voice = "";
    this._voiceOptionsSignature = null;
    this.reconcileVoiceSelection();
    this.pitch = 0;
    this.rate = 0;
    this.error = "";
    this.requestId = null;
    this.ttsUrl = null;
    this.status = "";
    this.duration = 0;
    this.cropStart = 0;
    this.cropEnd = 0;
    this.tagIds = new Set();
    this.saving = false;
    this.saveStatus = "";
  }

  async loadVoices() {
    if (this.loadingVoices || this.voices.length > 0) return;
    this.loadingVoices = true;
    this.status = "Loading voices…";
    this.render();
    try {
      const payload = await this.api.ttsVoices();
      const voices = Array.isArray(payload?.voices) ? payload.voices : [];
      const seen = new Set();
      const unique = voices
        .filter((voice) => voice && typeof voice.id === "string" && voice.id)
        .filter((voice) => {
          if (seen.has(voice.id)) return false;
          seen.add(voice.id);
          return true;
        })
        .sort((first, second) => {
          const nameOf = (voice) => (typeof voice.name === "string" ? voice.name : voice.id);
          return nameOf(first).localeCompare(nameOf(second), undefined, {
            sensitivity: "base",
            numeric: true,
          });
        });
      this.voices = unique.map((voice) => ({
        ...voice,
        _search: [voice.name, voice.id, voice.gender, voice.locale]
          .filter((field) => typeof field === "string")
          .join(" ")
          .toLocaleLowerCase(),
      }));
      if (!this.voice && unique.length > 0) {
        this.voice = unique[0].id;
      }
      this.reconcileVoiceSelection();
      this.renderVoiceOptions();
      if (unique.length === 0) {
        this.error = "No TTS voices were found.";
      }
      this.status = unique.length ? "Pick a voice and type your line." : "";
    } catch (error) {
      this.error = error instanceof Error ? error.message : "TTS voices could not be loaded.";
    } finally {
      this.loadingVoices = false;
      this.render();
    }
  }

  filteredVoices() {
    const needle = this.voiceFilter.trim().toLocaleLowerCase();
    if (!needle) return this.voices;
    return this.voices.filter((voice) =>
      (voice._search ?? [voice.name, voice.id, voice.gender, voice.locale]
        .filter((field) => typeof field === "string")
        .join(" ")
        .toLocaleLowerCase()
      ).includes(needle),
    );
  }

  reconcileVoiceSelection() {
    const visible = this.filteredVoices();
    if (!visible.some((voice) => voice.id === this.voice)) {
      this.voice = visible[0]?.id ?? "";
    }
  }

  renderVoiceOptions() {
    const select = this.elements.commentaryAddVoice;
    if (!select) return;
    // Rebuilding options on every render would collapse an open dropdown
    // during poll ticks and waste work on large catalogs; skip when inputs
    // are unchanged.
    const signature = `${this.voices.length}|${this.voices[0]?.id ?? ""}|${this.voiceFilter}`;
    if (signature === this._voiceOptionsSignature) return;
    this._voiceOptionsSignature = signature;
    const visible = this.filteredVoices();
    select.replaceChildren();
    for (const voice of visible) {
      const option = this.document.createElement("option");
      option.value = voice.id;
      option.textContent = [voice.name, voice.gender, voice.locale].filter(Boolean).join(" · ");
      select.append(option);
    }
  }

  async requestPreview() {
    if (this.busy()) return;
    const text = this.text.trim();
    if (!text || !this.voice) return;
    this.clearPreviewOnly();
    this.error = "";
    this.status = "Requesting preview…";
    this.saveStatus = "";
    try {
      const created = await this.api.requestTts(text, this.voice, this.pitch, this.rate);
      if (!created?.id) {
        throw new Error("The media server did not accept the preview request.");
      }
      this.requestId = created.id;
      this.status = "Queued for generation…";
      this.schedulePoll();
    } catch (error) {
      this.requestId = null;
      this.error = error instanceof Error ? error.message : "Preview could not be requested.";
    }
    this.render();
  }

  schedulePoll() {
    const requestId = this.requestId;
    if (!requestId) return;
    this.stopPolling();
    this.pollTimer = window.setTimeout(() => {
      this.poll(requestId);
    }, COMMENTARY_TTS_POLL_INTERVAL_MS);
  }

  async poll(requestId) {
    if (this.requestId !== requestId || !this.isOpen) return;
    let snapshot;
    try {
      snapshot = await this.api.ttsStatus(requestId);
    } catch (error) {
      if (this.requestId !== requestId || !this.isOpen) return;
      this.requestId = null;
      this.error = error instanceof Error ? error.message : "Preview status could not be checked.";
      this.render();
      return;
    }
    if (this.requestId !== requestId || !this.isOpen) return;
    const status = snapshot?.status;
    if (status === "completed") {
      this.ttsUrl = this.api.ttsFileUrl(requestId);
      this.requestId = null;
      this.status = "Loading preview…";
      this.previewAudio.src = this.ttsUrl;
      this.render();
      return;
    }
    if (status === "failed") {
      this.requestId = null;
      this.error = snapshot?.error || "The preview could not be generated.";
      this.render();
      return;
    }
    if (status === "cancelled") {
      this.requestId = null;
      this.status = "Preview cancelled.";
      this.render();
      return;
    }
    this.status = status === "running" ? "Generating preview…" : "Queued for generation…";
    this.render();
    this.schedulePoll();
  }

  async cancelPreview() {
    const requestId = this.requestId;
    this.stopPolling();
    this.stopPreview();
    this.requestId = null;
    this.status = "";
    if (requestId) {
      try {
        await this.api.cancelTts(requestId);
        this.status = "Preview cancelled.";
      } catch {
        this.status = "";
      }
    }
    this.render();
  }

  clearPreviewOnly() {
    this.stopPolling();
    this.stopPreview();
    this.duration = 0;
    this.cropStart = 0;
    this.cropEnd = 0;
    this.ttsUrl = null;
  }

  stopPolling() {
    if (this.pollTimer) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  stopPreview() {
    const audio = this.previewAudio;
    audio.pause();
    audio.removeAttribute("src");
    try {
      audio.load();
    } catch {
      // Some browsers throw when no source is set.
    }
    this.previewPlaying = false;
  }

  replay() {
    const audio = this.previewAudio;
    if (!audio.hasAttribute("src") || this.saving) return;
    audio.currentTime = this.cropStart;
    this.status = "Playing preview…";
    audio.play().catch(() => {
      this.status = "Preview could not be played.";
      this.render();
    });
    this.render();
  }

  async save() {
    if (this.saving || this.duration <= 0) return;
    this.saving = true;
    this.saveStatus = "Saving…";
    this.render();
    try {
      const crop = normalizeCrop(this.cropStart, this.cropEnd, this.duration);
      const file = await this.clipFile(crop);
      await this.api.saveCommentaryAudio(file, [...this.tagIds]);
      this.saving = false;
      this.saveStatus = "";
      this.close();
      this.render();
      await this.onSaved();
    } catch (error) {
      this.saving = false;
      this.saveStatus = error instanceof Error ? `Save failed: ${error.message}` : "Save failed.";
      this.render();
    }
  }

  async clipFile(crop) {
    if (!crop.start && crop.end >= this.duration - 0.001) {
      const blob = await this.api.downloadTtsPreview(this.ttsUrl);
      return new File([blob], "commentary.mp3", { type: "audio/mpeg" });
    }
    const audioContext = window.AudioContext || window.webkitAudioContext;
    if (!audioContext) {
      throw new Error("This browser can not apply audio trimming.");
    }
    const context = new audioContext();
    try {
      const blob = await this.api.downloadTtsPreview(this.ttsUrl);
      const buffer = await context.decodeAudioData(await blob.arrayBuffer());
      const clipped = cropAudioBuffer(buffer, crop.start, crop.end, context);
      const wav = audioBufferToWav(clipped);
      return new File([wav], "commentary-clip.wav", { type: "audio/wav" });
    } finally {
      if (context.state !== "closed") {
        await context.close().catch(() => {});
      }
    }
  }

  render() {
    const {
      addCommentary,
      commentaryAddRowHint,
      commentaryAddPopup,
      commentaryAddText,
      commentaryAddVoice,
      commentaryAddVoiceFilter,
      commentaryAddPitch,
      commentaryAddPitchValue,
      commentaryAddRate,
      commentaryAddRateValue,
      commentaryAddHint,
      commentaryAddPreview,
      commentaryAddCancelTts,
      commentaryAddStatus,
      commentaryAddReplay,
      commentaryAddStart,
      commentaryAddEnd,
      commentaryAddCropLabel,
      commentaryAddSave,
      commentaryAddSaveStatus,
    } = this.elements;
    if (!addCommentary) return;
    const disabledReason = this.disabledReason();
    addCommentary.disabled = Boolean(disabledReason);
    addCommentary.title = disabledReason;
    commentaryAddRowHint.textContent = disabledReason
      ? disabledReason
      : "Type a line, preview the voice, then save a clip into the commentary folder.";
    if (disabledReason && this.isOpen) {
      this.close();
    }
    commentaryAddPopup.hidden = !this.isOpen;
    if (!this.isOpen) {
      return;
    }

    const busy = this.busy();
    commentaryAddPitch.value = String(this.pitch);
    commentaryAddPitchValue.textContent = `${this.pitch >= 0 ? "+" : ""}${this.pitch} Hz`;
    commentaryAddRate.value = String(this.rate);
    commentaryAddRateValue.textContent = `${this.rate >= 0 ? "+" : ""}${this.rate}%`;
    if (commentaryAddText.value !== this.text) {
      commentaryAddText.value = this.text;
    }
    if (commentaryAddVoiceFilter && commentaryAddVoiceFilter.value !== this.voiceFilter) {
      commentaryAddVoiceFilter.value = this.voiceFilter;
    }
    this.renderVoiceOptions();
    commentaryAddVoice.value = this.voice;
    commentaryAddVoice.disabled = this.loadingVoices || this.voices.length === 0;
    if (commentaryAddVoiceFilter) {
      commentaryAddVoiceFilter.disabled = this.loadingVoices
        || this.saving
        || this.voices.length === 0;
    }
    commentaryAddPreview.disabled = busy
      || !this.voice
      || this.text.trim().length === 0;
    commentaryAddReplay.hidden = !this.previewAudio.hasAttribute("src");
    const noVoiceMatch = !this.error && !this.status
      && this.voices.length > 0 && this.filteredVoices().length === 0;
    commentaryAddHint.textContent = this.error || this.status
      || (noVoiceMatch ? "No voices match this filter." : "");
    commentaryAddHint.classList.toggle("commentary-add-error", Boolean(this.error));
    commentaryAddStatus.textContent = this.loadingVoices && this.voices.length === 0
      ? "Loading voices…"
      : busy && this.requestId
        ? (this.status || "Generating preview…")
        : "";
    commentaryAddCancelTts.hidden = !this.requestId;

    const hasPreview = Number.isFinite(this.duration) && this.duration > 0;
    const max = hasPreview ? String(this.duration) : "0";
    commentaryAddStart.max = max;
    commentaryAddEnd.max = max;
    const crop = normalizeCrop(this.cropStart, this.cropEnd, this.duration);
    commentaryAddStart.value = String(crop.start);
    commentaryAddEnd.value = String(crop.end);
    const trimmed = hasPreview && (crop.start > 0 || crop.end < this.duration - 0.001);
    commentaryAddCropLabel.textContent = trimmed
      ? `${timeLabel(crop.start)} – ${timeLabel(crop.end)}`
      : "Full length";
    commentaryAddStart.disabled = commentaryAddEnd.disabled = !hasPreview || this.saving;
    commentaryAddSave.disabled = this.saving || !hasPreview || Boolean(this.requestId);
    commentaryAddSaveStatus.textContent = this.saveStatus;
    this.renderTags();
  }

  renderTags() {
    const container = this.elements.commentaryAddTags;
    container.replaceChildren();
    const tags = this.getTags();
    if (tags.length === 0) {
      const hint = this.document.createElement("small");
      hint.className = "commentary-add-tag-hint";
      hint.textContent = "No shared tags yet. Create tags in the Tags panel to assign them here.";
      container.append(hint);
      return;
    }
    for (const tag of tags.slice(0, COMMENTARY_ADD_MAX_TAGS)) {
      const label = this.document.createElement("label");
      const checkbox = this.document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = tag.id;
      checkbox.checked = this.tagIds.has(tag.id);
      checkbox.disabled = this.saving;
      checkbox.setAttribute("aria-label", `Tag new commentary with ${tag.name}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.tagIds.add(tag.id);
        else this.tagIds.delete(tag.id);
      });
      const pill = createTagPill(this.document, { tagId: tag.id, label: tag.name });
      label.append(checkbox, pill);
      container.append(label);
    }
    if (tags.length > COMMENTARY_ADD_MAX_TAGS) {
      const more = this.document.createElement("small");
      more.className = "commentary-add-tag-hint";
      more.textContent = `+${tags.length - COMMENTARY_ADD_MAX_TAGS} more tags not shown.`;
      container.append(more);
    }
  }

  dispose() {
    this.stopPolling();
    this.stopPreview();
    for (const [event, handler] of Object.entries(this.handlers)) {
      this.previewAudio.removeEventListener(event, handler);
    }
  }
}
