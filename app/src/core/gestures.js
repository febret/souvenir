const DEFAULT_LIMITS = Object.freeze({
  position: 50,
  dimensions: { minWidth: 0.2, maxWidth: 5, minHeight: 0.15, maxHeight: 5 },
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

/**
 * Resolves the interaction mode for a panel given the number of pinching
 * hands.
 *
 * Unlocked panels move with one hand and move/reorient/rescale with two.
 * Locked panels ignore one-hand movement (the interaction layer treats a
 * single-hand pinch as next-media advance) and only rescale with two hands.
 * In Zen mode panels are fully locked: one-hand pinch still advances media,
 * two-hand pinches do nothing.
 */
export function interactionMode(panel, hands, { zen = false } = {}) {
  if (!panel || hands < 1) return "none";
  if (zen) return hands === 1 ? "next-media" : "none";
  if (panel.locked) return hands === 1 ? "next-media" : "panel-rescale";
  return "panel-transform";
}

export function applyPanelGesture(panel, gesture, limits = {}, options = {}) {
  if (!panel || !gesture) return panel ? copy(panel) : null;
  const result = copy(panel);
  const bound = resolvedLimits(limits);
  const mode = interactionMode(result, gesture.hands, options);

  if (mode === "panel-transform") {
    const movement = delta(gesture.translation);
    const rotation = delta(gesture.rotation);
    result.transform.position.x = clamp(result.transform.position.x + movement.x, -bound.position, bound.position);
    result.transform.position.y = clamp(result.transform.position.y + movement.y, -bound.position, bound.position);
    result.transform.position.z = clamp(result.transform.position.z + movement.z, -bound.position, bound.position);
    result.transform.rotation.x = wrappedAngle(result.transform.rotation.x + rotation.x);
    result.transform.rotation.y = wrappedAngle(result.transform.rotation.y + rotation.y);
    result.transform.rotation.z = wrappedAngle(result.transform.rotation.z + rotation.z);
    if (Number.isFinite(gesture.scale) && gesture.scale > 0 && gesture.scale !== 1) {
      result.dimensions.width = clamp(result.dimensions.width * gesture.scale, bound.dimensions.minWidth, bound.dimensions.maxWidth);
      result.dimensions.height = clamp(result.dimensions.height * gesture.scale, bound.dimensions.minHeight, bound.dimensions.maxHeight);
    }
  } else if (mode === "panel-rescale") {
    const scale = clamp(numeric(gesture.scale) || 1, 0.01, 100);
    result.dimensions.width = clamp(result.dimensions.width * scale, bound.dimensions.minWidth, bound.dimensions.maxWidth);
    result.dimensions.height = clamp(result.dimensions.height * scale, bound.dimensions.minHeight, bound.dimensions.maxHeight);
  }
  // "next-media" and "none" modes leave the panel state untouched; media
  // navigation is handled by the interaction layer on pinch release.
  return result;
}
