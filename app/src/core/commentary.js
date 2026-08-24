function normalizedTags(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Set)) {
    return normalizedTags(value.tag_ids ?? value.tagIds ?? value.tags ?? value.id);
  }
  const tags = Array.isArray(value) || value instanceof Set
    ? value
    : value == null ? [] : [value];
  return [...new Set([...tags]
    .map((tag) => tag && typeof tag === "object" ? tag.id : tag)
    .filter((tag) => typeof tag === "string" || typeof tag === "number")
    .map((tag) => String(tag).trim())
    .filter(Boolean))];
}

function tagsForEntry(entry) {
  return normalizedTags(entry?.tag_ids ?? entry?.tagIds ?? entry?.tags);
}

function lookupTags(tagLookup, path) {
  if (!path || !tagLookup) return [];
  if (typeof tagLookup === "function") return normalizedTags(tagLookup(path));
  if (typeof tagLookup.get === "function") return normalizedTags(tagLookup.get(path));
  return normalizedTags(tagLookup[path]);
}

function currentMediaPath(panel) {
  const media = panel?.media;
  return String(
    media?.selectedId
    ?? media?.path
    ?? media?.id
    ?? panel?.selectedId
    ?? panel?.currentMedia?.path
    ?? panel?.currentMedia?.id
    ?? panel?.currentMedia
    ?? panel?.mediaPath
    ?? "",
  ).trim();
}

function countFor(counts, tag) {
  const value = typeof counts?.get === "function" ? counts.get(tag) : counts?.[tag];
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

function compareEntries(left, right) {
  const leftName = String(left?.name ?? "");
  const rightName = String(right?.name ?? "");
  return leftName.localeCompare(rightName, undefined, { numeric: true, sensitivity: "base" })
    || String(left?.path ?? "").localeCompare(String(right?.path ?? ""), undefined, {
      numeric: true,
      sensitivity: "base",
    });
}

function boundedRandom(random) {
  const value = Number(typeof random === "function" ? random() : Math.random());
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 1 - Number.EPSILON);
}

export const MAX_COMMENTARY_VOLUME = 4;

export function normalizeCommentaryVolume(value) {
  const volume = Number(value);
  if (!Number.isFinite(volume)) return 1;
  return Math.min(MAX_COMMENTARY_VOLUME, Math.max(0, volume));
}

export function createCommentaryVolumeController(
  audio,
  {
    createAudioContext = () => {
      const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      return AudioContextClass ? new AudioContextClass() : null;
    },
  } = {},
) {
  let audioContext = null;
  let sourceNode = null;
  let gainNode = null;

  return {
    prepare(value) {
      const volume = normalizeCommentaryVolume(value);
      if (volume <= 1 || gainNode || !audio) return volume;
      const context = createAudioContext();
      if (
        !context
        || typeof context.createMediaElementSource !== "function"
        || typeof context.createGain !== "function"
      ) {
        return volume;
      }
      const source = context.createMediaElementSource(audio);
      const gain = context.createGain();
      source.connect(gain);
      gain.connect(context.destination);
      gain.gain.value = volume;
      audioContext = context;
      sourceNode = source;
      gainNode = gain;
      return volume;
    },

    apply(value) {
      const volume = normalizeCommentaryVolume(value);
      if (audio) audio.volume = Math.min(1, volume);
      if (gainNode) gainNode.gain.value = volume > 1 ? volume : 1;
      return volume;
    },

    dispose() {
      sourceNode?.disconnect?.();
      gainNode?.disconnect?.();
      void audioContext?.close?.();
      audioContext = null;
      sourceNode = null;
      gainNode = null;
    },
  };
}

export function aggregatePanelTagCounts(panels, tagLookup) {
  const counts = {};
  for (const panel of Array.isArray(panels) ? panels : []) {
    if (panel?.open === false || panel?.closed === true) continue;
    const path = currentMediaPath(panel);
    for (const tag of lookupTags(tagLookup, path)) {
      counts[tag] = (counts[tag] ?? 0) + 1;
    }
  }
  return counts;
}

export function aggregateEntryTagCounts(entries) {
  const counts = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const tag of tagsForEntry(entry)) {
      counts[tag] = (counts[tag] ?? 0) + 1;
    }
  }
  return counts;
}

export function normalizeTagFrequency(counts) {
  const normalized = {};
  const entries = Object.entries(counts ?? {})
    .map(([tag, value]) => [String(tag), Math.max(0, Number(value) || 0)])
    .filter(([tag, value]) => tag && value > 0);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!(total > 0)) return normalized;
  for (const [tag, value] of entries) {
    normalized[tag] = value / total;
  }
  return normalized;
}

export function suggestCommentaryTags(mediaCounts, commentaryCounts, { limit = 5 } = {}) {
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (safeLimit === 0) return [];
  const mediaFrequency = normalizeTagFrequency(mediaCounts);
  const commentaryFrequency = normalizeTagFrequency(commentaryCounts);
  return Object.entries(mediaFrequency)
    .map(([tag, media]) => {
      const commentary = commentaryFrequency[tag] ?? 0;
      return {
        tag,
        mediaFrequency: media,
        commentaryFrequency: commentary,
        gap: media - commentary,
      };
    })
    .filter((entry) => entry.gap > 0)
    .sort((left, right) =>
      right.gap - left.gap
      || right.mediaFrequency - left.mediaFrequency
      || left.tag.localeCompare(right.tag, undefined, { sensitivity: "base", numeric: true }))
    .slice(0, safeLimit);
}

export function scoreCommentary(entries, counts) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      ...entry,
      score: tagsForEntry(entry).reduce((total, tag) => total + countFor(counts, tag), 0),
    }))
    .sort((left, right) => right.score - left.score || compareEntries(left, right));
}

export function selectCommentary(entries, counts, { random = Math.random, previousPath } = {}) {
  const scored = scoreCommentary(entries, counts);
  const positive = scored.filter((entry) => entry.score > 0).slice(0, 3);
  let eligible = positive.length ? positive : scored;
  if (eligible.length > 1 && previousPath != null) {
    const withoutPrevious = eligible.filter((entry) => entry.path !== previousPath);
    if (withoutPrevious.length) eligible = withoutPrevious;
  }
  if (!eligible.length) return null;

  const value = boundedRandom(random);
  if (!positive.length) {
    return eligible[Math.min(eligible.length - 1, Math.floor(value * eligible.length))];
  }

  const total = eligible.reduce((sum, entry) => sum + entry.score, 0);
  let target = value * total;
  for (const entry of eligible) {
    target -= entry.score;
    if (target < 0) return entry;
  }
  return eligible.at(-1);
}
