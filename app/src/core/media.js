import { normalizeTagIds } from "./tags.js";

export const SORT_MODES = Object.freeze({
  NAME: "name",
  MTIME: "mtime",
  SIZE: "size",
  RANDOM: "random",
});

export function mediaId(media) {
  return String(media?.id ?? media?.path ?? media?.url ?? media?.name ?? "");
}

export function normalizeMediaEntry(entry) {
  const path = String(entry?.path ?? entry?.id ?? "");
  const type = entry?.media_type ?? entry?.mediaType ?? entry?.type ?? "";
  const modified = entry?.mtimeMs ?? entry?.mtime ?? entry?.modified;
  const mtime = Number.isFinite(modified)
    ? modified
    : Date.parse(modified) || 0;
  return {
    ...entry,
    id: path,
    path,
    type,
    mimeType: type,
    mtime,
    directory: path.split("/").slice(0, -1).join("/"),
    tag_ids: normalizeTagIds(entry?.tag_ids),
  };
}

export function isVideo(media) {
  return Boolean(media?.isVideo)
    || /^video\//i.test(media?.mimeType ?? media?.type ?? "")
    || /\.(mp4|m4v|mov|webm|avi|mkv)$/i.test(media?.name ?? media?.path ?? "");
}

export function isImage(media) {
  return !isVideo(media) && (Boolean(media?.isImage)
    || /^image\//i.test(media?.mimeType ?? media?.type ?? "")
    || /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(media?.name ?? media?.path ?? ""));
}

function textCompare(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true, sensitivity: "base" });
}

function numericValue(value) {
  return Number.isFinite(value) ? value : 0;
}

function hash(seed, input) {
  let value = 2166136261;
  const text = `${seed}:${input}`;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

export function sortMedia(media, { mode = SORT_MODES.NAME, seed = "" } = {}) {
  const result = [...(Array.isArray(media) ? media : [])];
  const stableIdCompare = (left, right) => textCompare(mediaId(left), mediaId(right));

  result.sort((left, right) => {
    let comparison;
    switch (mode) {
      case SORT_MODES.MTIME:
        comparison = numericValue(right.mtimeMs ?? right.mtime) - numericValue(left.mtimeMs ?? left.mtime);
        break;
      case SORT_MODES.SIZE:
        comparison = numericValue(left.size) - numericValue(right.size);
        break;
      case SORT_MODES.RANDOM:
        comparison = hash(seed, mediaId(left)) - hash(seed, mediaId(right));
        break;
      case SORT_MODES.NAME:
      default:
        comparison = textCompare(left.name, right.name);
        break;
    }
    return comparison || stableIdCompare(left, right);
  });
  return result;
}

export function createPersistentRandomSeed({ storage, key = "souvenir.media-random-seed", random = Math.random } = {}) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    throw new TypeError("A Storage-compatible object is required.");
  }
  const existing = storage.getItem(key);
  if (existing) {
    return existing;
  }
  const seed = `${Date.now().toString(36)}-${Math.floor(random() * Number.MAX_SAFE_INTEGER).toString(36)}`;
  storage.setItem(key, seed);
  return seed;
}
