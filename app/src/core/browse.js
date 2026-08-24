import { normalizeTagIds } from "./tags.js";

export const MIN_BROWSE_ZOOM = 1;
export const MAX_BROWSE_ZOOM = 8;

export function matchesTagCountFilter(entry, filter) {
  const count = normalizeTagIds(entry?.tag_ids).length;
  switch (filter) {
    case "0":
      return count === 0;
    case "1-2":
      return count >= 1 && count <= 2;
    case "3-10":
      return count >= 3 && count <= 10;
    case "10+":
      return count >= 10;
    default:
      return true;
  }
}

export function updateBrowseSelection(
  selectedIds,
  orderedIds,
  index,
  { toggle = false, range = false, anchorIndex = null } = {},
) {
  const ids = Array.isArray(orderedIds) ? orderedIds : [];
  if (index < 0 || index >= ids.length) {
    return { selectedIds: new Set(selectedIds), anchorIndex };
  }
  const next = new Set(selectedIds);
  if (range && Number.isInteger(anchorIndex)) {
    const start = Math.min(anchorIndex, index);
    const end = Math.max(anchorIndex, index);
    if (!toggle) next.clear();
    ids.slice(start, end + 1).forEach((id) => next.add(id));
  } else if (toggle) {
    const id = ids[index];
    if (next.has(id)) next.delete(id);
    else next.add(id);
  } else {
    next.clear();
    next.add(ids[index]);
  }
  return { selectedIds: next, anchorIndex: index };
}

export function tagSelectionState(entries, tagId) {
  if (!entries.length) return { checked: false, indeterminate: false };
  const assigned = entries.filter((entry) =>
    normalizeTagIds(entry?.tag_ids).includes(String(tagId)));
  return {
    checked: assigned.length === entries.length,
    indeterminate: assigned.length > 0 && assigned.length < entries.length,
  };
}

export function assignmentsAfterTagToggle(entries, tagId, assigned) {
  const normalizedId = String(tagId);
  return entries.map((entry) => {
    const current = normalizeTagIds(entry?.tag_ids);
    const tagIds = assigned
      ? [...new Set([...current, normalizedId])]
      : current.filter((id) => id !== normalizedId);
    return { path: entry.path, tag_ids: tagIds };
  });
}

export function clampBrowseTransform(
  transform,
  { stageWidth, stageHeight, naturalWidth, naturalHeight },
) {
  const zoom = Math.min(
    MAX_BROWSE_ZOOM,
    Math.max(MIN_BROWSE_ZOOM, Number(transform?.zoom) || MIN_BROWSE_ZOOM),
  );
  if (![stageWidth, stageHeight, naturalWidth, naturalHeight].every((value) => value > 0)) {
    return { zoom, x: 0, y: 0 };
  }
  const fitScale = Math.min(stageWidth / naturalWidth, stageHeight / naturalHeight);
  const width = naturalWidth * fitScale * zoom;
  const height = naturalHeight * fitScale * zoom;
  const maxX = Math.max(0, (width - stageWidth) / 2);
  const maxY = Math.max(0, (height - stageHeight) / 2);
  return {
    zoom,
    x: Math.min(maxX, Math.max(-maxX, Number(transform?.x) || 0)),
    y: Math.min(maxY, Math.max(-maxY, Number(transform?.y) || 0)),
  };
}

export function zoomBrowseTransform(transform, zoom, point = { x: 0, y: 0 }) {
  const previousZoom = Number(transform?.zoom) || MIN_BROWSE_ZOOM;
  const nextZoom = Math.min(MAX_BROWSE_ZOOM, Math.max(MIN_BROWSE_ZOOM, zoom));
  const ratio = nextZoom / previousZoom;
  return {
    zoom: nextZoom,
    x: point.x - (point.x - (Number(transform?.x) || 0)) * ratio,
    y: point.y - (point.y - (Number(transform?.y) || 0)) * ratio,
  };
}
