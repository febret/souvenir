import { normalizeEnvironmentMode } from "./environment-mode.js";

export const MAX_SNAPSHOTS = 8;
export const SNAPSHOT_HOLD_MS = 600;

const copy = (value) => JSON.parse(JSON.stringify(value));

/**
 * A snapshot is a full serializable scene: every panel (including minimized
 * ones) with its media, transform, scale, and display settings, plus the
 * focused panel and environment mode. Slideshow playback is intentionally not
 * captured, so restoring a snapshot always yields stopped slideshows.
 */
export function createSnapshot({ panels, focusedId, environmentMode } = {}) {
  return {
    panels: Array.isArray(panels) ? copy(panels) : [],
    focusedId: typeof focusedId === "string" ? focusedId : null,
    environmentMode: normalizeEnvironmentMode(environmentMode),
    createdAt: Date.now(),
  };
}

export function normalizeSnapshot(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.panels)) {
    return null;
  }
  const panels = value.panels.filter(
    (panel) => panel && typeof panel === "object" && typeof panel.id === "string" && panel.id,
  );
  return {
    panels: copy(panels),
    focusedId: typeof value.focusedId === "string" ? value.focusedId : null,
    environmentMode: normalizeEnvironmentMode(value.environmentMode),
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : 0,
  };
}

export function normalizeSnapshotSlots(value) {
  const slots = new Array(MAX_SNAPSHOTS).fill(null);
  if (!Array.isArray(value)) return slots;
  for (let index = 0; index < MAX_SNAPSHOTS; index += 1) {
    slots[index] = normalizeSnapshot(value[index]);
  }
  return slots;
}

export function firstEmptySlot(slots) {
  if (!Array.isArray(slots)) return -1;
  return slots.findIndex((slot) => !slot);
}

export function snapshotCount(slots) {
  return Array.isArray(slots) ? slots.filter(Boolean).length : 0;
}
