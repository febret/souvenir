import { mediaId } from "./media.js";

export function mediaIndex(playlist, selectedId) {
  return (Array.isArray(playlist) ? playlist : []).findIndex((media) => mediaId(media) === String(selectedId ?? ""));
}

export function mediaAt(playlist, index) {
  const items = Array.isArray(playlist) ? playlist : [];
  if (items.length === 0) {
    return null;
  }
  return items[((index % items.length) + items.length) % items.length] ?? null;
}

export function nextMedia(playlist, selectedId) {
  const index = mediaIndex(playlist, selectedId);
  return mediaAt(playlist, index < 0 ? 0 : index + 1);
}

export function previousMedia(playlist, selectedId) {
  const index = mediaIndex(playlist, selectedId);
  return mediaAt(playlist, index < 0 ? -1 : index - 1);
}
