/** Panel video transport is a fixed-step skip; it never jumps to a boundary. */
export const VIDEO_SEEK_STEP_SECONDS = 15;

/**
 * Resolves the absolute playback position for a relative seek. The result is
 * clamped to the media bounds so a repeated skip cannot move currentTime
 * outside the playable range. Returns null when the delta is unusable, so
 * callers leave currentTime untouched instead of writing a bad position.
 */
export function videoSeekTarget(currentTime, deltaSeconds, duration) {
  const delta = Number(deltaSeconds);
  if (!Number.isFinite(delta)) return null;
  const position = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
  const total = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(position + delta, 0), total);
}
