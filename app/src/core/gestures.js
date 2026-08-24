const DEFAULT_LIMITS = Object.freeze({
  position: 50,
  dimensions: { minWidth: 0.2, maxWidth: 5, minHeight: 0.15, maxHeight: 5 },
  contentPan: 3,
  contentZoom: { min: 0.25, max: 8 },
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const numeric = (value) => Number.isFinite(value) ? value : 0;
const delta = (value) => ({ x: numeric(value?.x), y: numeric(value?.y), z: numeric(value?.z) });
const copy = (value) => JSON.parse(JSON.stringify(value));

function wrappedAngle(value) {
  const fullTurn = Math.PI * 2;
  return ((value + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI;
}

function resolvedLimits(limits) {
  return {
    ...DEFAULT_LIMITS,
    ...limits,
    dimensions: { ...DEFAULT_LIMITS.dimensions, ...limits?.dimensions },
    contentZoom: { ...DEFAULT_LIMITS.contentZoom, ...limits?.contentZoom },
  };
}

export function createInteractionState({ panelId = null, hands = 0 } = {}) {
  return { panelId, hands: clamp(Math.trunc(numeric(hands)), 0, 2) };
}

export function updateInteractionState(state, event) {
  const current = createInteractionState(state);
  if (event?.type === "end") return createInteractionState();
  if (event?.type === "begin" || event?.type === "hands") {
    return createInteractionState({
      panelId: event.panelId ?? current.panelId,
      hands: event.hands ?? current.hands,
    });
  }
  return current;
}

export function interactionMode(panel, hands) {
  if (!panel || hands < 1) return "none";
  if (panel.minimized) return hands === 1 ? "minimized-move" : "none";
  if (panel.locked || panel.zoomMode) return hands === 1 ? "content-pan" : "content-zoom";
  return hands === 1 ? "panel-transform" : "panel-resize";
}

export function applyPanelGesture(panel, gesture, limits = {}) {
  if (!panel || !gesture) return panel ? copy(panel) : null;
  const result = copy(panel);
  const bound = resolvedLimits(limits);
  const mode = interactionMode(result, gesture.hands);

  if (mode === "panel-transform" || mode === "minimized-move") {
    const movement = delta(gesture.translation);
    const rotation = delta(gesture.rotation);
    result.transform.position.x = clamp(result.transform.position.x + movement.x, -bound.position, bound.position);
    result.transform.position.y = clamp(result.transform.position.y + movement.y, -bound.position, bound.position);
    result.transform.position.z = clamp(result.transform.position.z + movement.z, -bound.position, bound.position);
    result.transform.rotation.x = wrappedAngle(result.transform.rotation.x + rotation.x);
    result.transform.rotation.y = wrappedAngle(result.transform.rotation.y + rotation.y);
    result.transform.rotation.z = wrappedAngle(result.transform.rotation.z + rotation.z);
  } else if (mode === "panel-resize") {
    const scale = clamp(numeric(gesture.scale) || 1, 0.01, 100);
    result.dimensions.width = clamp(result.dimensions.width * scale, bound.dimensions.minWidth, bound.dimensions.maxWidth);
    result.dimensions.height = clamp(result.dimensions.height * scale, bound.dimensions.minHeight, bound.dimensions.maxHeight);
    result.restoreDimensions = copy(result.dimensions);
  } else if (mode === "content-pan") {
    const movement = delta(gesture.translation);
    result.content.pan.x = clamp(result.content.pan.x + movement.x, -bound.contentPan, bound.contentPan);
    result.content.pan.y = clamp(result.content.pan.y + movement.y, -bound.contentPan, bound.contentPan);
    result.content.pan.z = clamp(result.content.pan.z + movement.z, -bound.contentPan, bound.contentPan);
  } else if (mode === "content-zoom") {
    const scale = clamp(numeric(gesture.scale) || 1, 0.01, 100);
    result.content.zoom = clamp(result.content.zoom * scale, bound.contentZoom.min, bound.contentZoom.max);
  }
  return result;
}
