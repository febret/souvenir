import { isImage, isVideo, mediaId } from "./media.js";
import { nextMedia } from "./playlist.js";

const DEFAULT_INTERVAL_MS = 5000;

export function createSlideshowState({ active = false, intervalMs = DEFAULT_INTERVAL_MS, currentMediaId = null, lastAdvanceAt = 0 } = {}) {
  return {
    active: Boolean(active),
    intervalMs: Math.max(1000, Number.isFinite(intervalMs) ? intervalMs : DEFAULT_INTERVAL_MS),
    currentMediaId: currentMediaId == null ? null : String(currentMediaId),
    lastAdvanceAt: Math.max(0, Number.isFinite(lastAdvanceAt) ? lastAdvanceAt : 0),
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

  const following = nextMedia(playlist, current.currentMediaId ?? mediaId(currentMedia));
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
