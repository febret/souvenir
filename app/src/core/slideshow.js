import { isImage, isVideo, mediaId } from "./media.js";
import { SLIDESHOW_REPEAT_MODES, normalizeSlideshowRepeat } from "./panel-store.js";
import { isLastMedia, mediaIndex, nextMedia } from "./playlist.js";

const DEFAULT_INTERVAL_MS = 5000;

export { SLIDESHOW_REPEAT_MODES };

export function normalizeRepeatMode(mode) {
  return normalizeSlideshowRepeat(mode);
}

const REPEAT_CYCLE_ORDER = Object.freeze(["all", "one", "off"]);

export function cycleRepeatMode(mode) {
  const current = normalizeSlideshowRepeat(mode);
  const index = REPEAT_CYCLE_ORDER.indexOf(current);
  return REPEAT_CYCLE_ORDER[(index + 1) % REPEAT_CYCLE_ORDER.length] ?? "all";
}

export function randomMedia(playlist, random = Math.random) {
  const entries = Array.isArray(playlist) ? playlist : [];
  if (!entries.length) return null;
  const value = Number(random());
  const bounded = Number.isFinite(value) ? Math.min(0.999999999, Math.max(0, value)) : 0;
  return entries[Math.floor(bounded * entries.length)] ?? null;
}

export function createSlideshowState({ active = false, intervalMs = DEFAULT_INTERVAL_MS, currentMediaId = null, lastAdvanceAt = 0, shuffle = false, repeat = "all" } = {}) {
  return {
    active: Boolean(active),
    intervalMs: Math.max(1000, Number.isFinite(intervalMs) ? intervalMs : DEFAULT_INTERVAL_MS),
    currentMediaId: currentMediaId == null ? null : String(currentMediaId),
    lastAdvanceAt: Math.max(0, Number.isFinite(lastAdvanceAt) ? lastAdvanceAt : 0),
    shuffle: Boolean(shuffle),
    repeat: normalizeRepeatMode(repeat),
  };
}

export function playbackPolicy(media, { autoplayVideos = false, slideshowActive = false } = {}) {
  return {
    autoplay: isVideo(media) && (Boolean(autoplayVideos) || Boolean(slideshowActive)),
    loop: false,
  };
}

export function slideshowTransition(state, event, { playlist = [], currentMedia } = {}) {
  const current = createSlideshowState(state);
  const type = event?.type;
  const now = Number.isFinite(event?.now) ? event.now : current.lastAdvanceAt;

  if (type === "start") {
    return { state: { ...current, active: true, lastAdvanceAt: now }, action: null };
  }
  if (type === "stop") {
    return { state: { ...current, active: false }, action: null };
  }
  if (type === "set-current") {
    return {
      state: { ...current, currentMediaId: event.mediaId == null ? null : String(event.mediaId), lastAdvanceAt: now },
      action: null,
    };
  }
  if (!current.active || !currentMedia) {
    return { state: current, action: null };
  }

  const shouldAdvanceImage = type === "tick" && isImage(currentMedia) && now - current.lastAdvanceAt >= current.intervalMs;
  const shouldAdvanceVideo = type === "media-ended" && isVideo(currentMedia);
  if (!shouldAdvanceImage && !shouldAdvanceVideo) {
    return { state: current, action: null };
  }

  if (current.repeat === "one") {
    return {
      state: { ...current, currentMediaId: mediaId(currentMedia), lastAdvanceAt: now },
      action: { type: "advance", media: currentMedia },
    };
  }

  const random = typeof event?.random === "function" ? event.random : Math.random;
  if (current.shuffle) {
    const pool = (Array.isArray(playlist) ? playlist : []).filter(
      (item) => mediaId(item) !== mediaId(currentMedia),
    );
    const next = randomMedia(pool.length ? pool : playlist, random);
    if (!next) {
      return { state: { ...current, lastAdvanceAt: now }, action: null };
    }
    return {
      state: { ...current, currentMediaId: mediaId(next), lastAdvanceAt: now },
      action: { type: "advance", media: next },
    };
  }

  const anchor = mediaIndex(playlist, current.currentMediaId) < 0
    ? mediaId(currentMedia)
    : current.currentMediaId;
  if (current.repeat === "off" && isLastMedia(playlist, anchor)) {
    return { state: { ...current, active: false, lastAdvanceAt: now }, action: null };
  }
  const following = nextMedia(playlist, anchor);
  if (!following) {
    return { state: { ...current, lastAdvanceAt: now }, action: null };
  }
  return {
    state: { ...current, currentMediaId: mediaId(following), lastAdvanceAt: now },
    action: { type: "advance", media: following },
  };
}

export function slideshowDelay(state, currentMedia) {
  const current = createSlideshowState(state);
  return current.active && isImage(currentMedia) ? current.intervalMs : null;
}

/**
 * True when an advance action targets the currently selected media. The
 * coordinator re-shows (rather than `setMedia`) in that case because the panel
 * store treats a same-id selection change as a no-op and would never reload.
 */
export function shouldReplayAdvance(action, currentSelectedId) {
  if (!action || action.type !== "advance" || !action.media) return false;
  const next = mediaId(action.media);
  if (!next) return false;
  return next === String(currentSelectedId ?? "");
}
