const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Keeps the desktop options window a readable distance from the host edges. */
export const OPTIONS_WINDOW_MARGIN = 8;

/**
 * Resolves where a panel's options window is drawn. The window is stored as a
 * free offset from the panel it belongs to, so moving the panel carries the
 * window along. The clamp only applies to the drawn position: the offset stays
 * exactly where the user dragged it, so the window can always be pulled back
 * from the edge without dragging against the clamp first.
 */
export function optionsWindowPosition({
  anchor,
  offset,
  host,
  size,
  margin = OPTIONS_WINDOW_MARGIN,
} = {}) {
  const hostWidth = Math.max(0, finite(host?.width));
  const hostHeight = Math.max(0, finite(host?.height));
  const windowWidth = Math.max(0, finite(size?.width));
  const windowHeight = Math.max(0, finite(size?.height));
  const gap = Math.max(0, finite(margin));
  return {
    x: Math.round(clamp(
      finite(anchor?.x) + finite(offset?.x),
      gap,
      Math.max(gap, hostWidth - windowWidth - gap),
    )),
    y: Math.round(clamp(
      finite(anchor?.y) + finite(offset?.y),
      gap,
      Math.max(gap, hostHeight - windowHeight - gap),
    )),
  };
}
