import { MAX_SNAPSHOTS, normalizeSnapshotSlots } from "../core/snapshots.js";
import { validateLibraryId } from "./layout-storage.js";

export const SNAPSHOT_STORAGE_KEY = "souvenir.snapshots.v1";

function emptySlots() {
  return new Array(MAX_SNAPSHOTS).fill(null);
}

export function loadSnapshotSlots(storage, currentLibraryId) {
  const libraryId = validateLibraryId(currentLibraryId);
  const raw = storage.getItem(SNAPSHOT_STORAGE_KEY);
  if (!raw) return emptySlots();
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new TypeError("The saved snapshots are invalid.");
  }
  if (
    typeof parsed.libraryId !== "string" ||
    !parsed.libraryId.trim() ||
    parsed.libraryId !== libraryId
  ) {
    return emptySlots();
  }
  return normalizeSnapshotSlots(parsed.slots);
}

export function saveSnapshotSlots(storage, slots, currentLibraryId) {
  const libraryId = validateLibraryId(currentLibraryId);
  storage.setItem(
    SNAPSHOT_STORAGE_KEY,
    JSON.stringify({ slots: normalizeSnapshotSlots(slots), libraryId }),
  );
}
