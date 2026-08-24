export const CAPTION_MESSAGE_DURATION_MS = 1000;

export function parseCaptionTimeline(caption) {
  const timeline = [];
  let elapsedMs = 0;
  for (const token of String(caption ?? "").match(/#+|[^#]+/g) ?? []) {
    if (token.startsWith("#")) {
      elapsedMs += token.length * 1000;
      continue;
    }
    const text = token.trim();
    if (!text) continue;
    timeline.push({
      text,
      startMs: elapsedMs,
      endMs: elapsedMs + CAPTION_MESSAGE_DURATION_MS,
    });
    elapsedMs += CAPTION_MESSAGE_DURATION_MS;
  }
  return timeline;
}

export function captionAtTime(timeline, timeSeconds) {
  const elapsedMs = Math.max(0, Number(timeSeconds) || 0) * 1000;
  return (Array.isArray(timeline) ? timeline : [])
    .find((caption) => elapsedMs >= caption.startMs && elapsedMs < caption.endMs)
    ?.text ?? "";
}
