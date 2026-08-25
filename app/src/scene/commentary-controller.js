import {
  aggregatePanelTagCounts,
  captionAtTime,
  createCommentaryVolumeController,
  normalizeCommentaryVolume,
  normalizeTagIds,
  parseCaptionTimeline,
  scoreCommentary,
  selectCommentary,
} from "../core/index.js";
import { CaptionView } from "./caption-view.js";

function normalizedEntries(payload) {
  const values = Array.isArray(payload)
    ? payload
    : payload?.entries ?? payload?.items ?? payload?.commentary ?? payload?.sounds ?? [];
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((entry) => {
      const path = String(entry?.path ?? entry?.file_path ?? entry?.filePath ?? "").trim();
      return {
        ...entry,
        path,
        name: String(entry?.name ?? path.split("/").at(-1) ?? "").trim(),
        caption: typeof entry?.caption === "string" ? entry.caption : "",
        volume: normalizeCommentaryVolume(entry?.volume),
        tag_ids: normalizeTagIds(
          entry?.tag_ids
          ?? entry?.tagIds
          ?? (Array.isArray(entry?.tags) ? entry.tags.map((tag) => tag?.id ?? tag) : entry?.tags),
        ),
      };
    })
    .filter((entry) => entry.path && !seen.has(entry.path) && seen.add(entry.path));
}

// Owns spatial commentary selection, audio playback, captions, and UI state.
export class CommentaryController {
  constructor({
    api,
    scene,
    getPanels,
    getMediaTagLookup,
    getSettings,
    onStateChange,
    onError,
    createAudio,
    captionView = null,
  }) {
    this.api = api;
    this.getPanels = getPanels;
    this.getMediaTagLookup = getMediaTagLookup;
    this.getSettings = getSettings;
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.createAudio = createAudio;
    this.captionView = captionView ?? new CaptionView();
    if (!captionView) scene.add(this.captionView);

    this.entries = [];
    this.scores = [];
    this.path = null;
    this.available = false;
    this.enabled = false;
    this.playing = false;
    this.audio = null;
    this.audioVolume = null;
    this.playbackGeneration = 0;
    this.captionTimeline = [];
    this.disposed = false;
    this.onEnded = () => {
      if (!this.enabled || this.disposed) return;
      this.play().catch((error) => this.fail(error));
    };
    this.onAudioError = () => {
      if (!this.enabled || this.disposed) return;
      this.fail(new Error("The commentary audio could not be played."));
    };
  }

  syncState() {
    this.onStateChange?.({
      available: this.available,
      enabled: this.enabled,
      playing: this.playing,
    });
  }

  async refresh({ reportError = false } = {}) {
    try {
      const entries = normalizedEntries(await this.api.commentary());
      this.entries = entries;
      this.available = entries.length > 0;
      if (!this.available && this.enabled) this.stop();
      else this.syncState();
      return entries;
    } catch (error) {
      if (!reportError) throw error;
      this.entries = [];
      this.available = false;
      this.stop();
      this.onError?.(new Error(`Could not refresh commentary: ${error.message}`));
      return [];
    }
  }

  ensureAudio() {
    if (this.audio) return this.audio;
    const audio = this.createAudio();
    audio.preload = "auto";
    audio.addEventListener("ended", this.onEnded);
    audio.addEventListener("error", this.onAudioError);
    this.audio = audio;
    this.audioVolume = createCommentaryVolumeController(audio);
    return audio;
  }

  clearAudio() {
    if (!this.audio) return;
    this.audio.pause?.();
    this.audio.removeAttribute?.("src");
    if (!this.audio.removeAttribute) this.audio.src = "";
    this.audio.load?.();
  }

  stop() {
    this.playbackGeneration += 1;
    this.enabled = false;
    this.playing = false;
    this.clearAudio();
    this.syncState();
  }

  fail(error) {
    const detail = error?.message ?? String(error ?? "Unknown audio error.");
    this.stop();
    this.onError?.(new Error(`Commentary playback failed: ${detail}`));
  }

  async toggle() {
    if (this.enabled) {
      this.stop();
      return;
    }
    if (!this.available) {
      this.syncState();
      this.onError?.(new Error("Commentary is unavailable because no commentary files were found."));
      return;
    }
    this.enabled = true;
    this.playing = false;
    this.syncState();
    const refresh = this.refresh();
    await this.play();
    await refresh;
  }

  async play() {
    if (!this.enabled) return null;
    const counts = aggregatePanelTagCounts(this.getPanels(), this.getMediaTagLookup());
    this.scores = scoreCommentary(this.entries, counts);
    const entry = selectCommentary(this.entries, counts, { previousPath: this.path });
    if (!entry) throw new Error("No commentary files are available.");

    const audio = this.ensureAudio();
    const generation = ++this.playbackGeneration;
    this.path = entry.path;
    this.captionTimeline = parseCaptionTimeline(entry.caption);
    this.captionView.setText(captionAtTime(this.captionTimeline, 0));
    this.playing = false;
    this.syncState();
    audio.src = this.api.commentaryFileUrl(entry.path);
    this.audioVolume?.prepare(entry.volume);
    this.audioVolume?.apply(entry.volume);
    audio.load?.();
    try {
      await audio.play();
    } catch (error) {
      if (this.enabled && generation === this.playbackGeneration) throw error;
      return null;
    }
    if (!this.enabled || generation !== this.playbackGeneration) {
      audio.pause?.();
      return null;
    }
    this.playing = true;
    this.syncState();
    return entry;
  }

  update(viewCamera) {
    const settings = this.getSettings();
    this.captionView.setStyle({
      size: settings.captionSize,
      transparency: settings.captionTransparency,
    });
    this.captionView.setText(
      this.enabled && this.audio
        ? captionAtTime(this.captionTimeline, this.audio.currentTime)
        : "",
    );
    this.captionView.updatePose(viewCamera, settings.captionDistance);
  }

  dispose() {
    this.stop();
    this.disposed = true;
    if (this.audio) {
      this.audio.removeEventListener("ended", this.onEnded);
      this.audio.removeEventListener("error", this.onAudioError);
      this.audioVolume?.dispose();
      this.audioVolume = null;
      this.clearAudio();
      this.captionTimeline = [];
      this.captionView.setText("");
      this.audio = null;
    }
    this.captionView.dispose();
  }
}
