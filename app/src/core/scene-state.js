export const MIN_SCENE_DURATION_SEC = 1;
export const MAX_SCENE_DURATION_SEC = 60;
export const DEFAULT_SCENE_DURATION_SEC = 8;

const numberOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const randomId = () => `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 18)}`.slice(0, 32).padEnd(32, "0");

function clampDuration(value, fallback = DEFAULT_SCENE_DURATION_SEC) {
  const numeric = Math.round(numberOr(value, fallback));
  return Math.max(MIN_SCENE_DURATION_SEC, Math.min(MAX_SCENE_DURATION_SEC, numeric));
}

function vector(value, fallback) {
  return {
    x: numberOr(value?.x, fallback.x),
    y: numberOr(value?.y, fallback.y),
    z: numberOr(value?.z, fallback.z),
  };
}

function dimensions(value, fallback = { width: 1.2, height: 0.8 }) {
  return {
    width: Math.max(0.05, numberOr(value?.width, fallback.width)),
    height: Math.max(0.05, numberOr(value?.height, fallback.height)),
  };
}

function panelSnapshot(panel) {
  return {
    id: String(panel?.id ?? ""),
    media: {
      directory: typeof panel?.media?.directory === "string" ? panel.media.directory : null,
      selectedId: typeof panel?.media?.selectedId === "string" ? panel.media.selectedId : null,
      sort: typeof panel?.media?.sort === "string" ? panel.media.sort : "name",
      view: typeof panel?.media?.view === "string" ? panel.media.view : "thumbnails",
    },
    transform: {
      position: vector(panel?.transform?.position, { x: 0, y: 1.35, z: -1.45 }),
      rotation: vector(panel?.transform?.rotation, { x: 0, y: 0, z: 0 }),
    },
    dimensions: dimensions(panel?.dimensions),
  };
}

export function createSceneShot(value = {}, { idFactory } = {}) {
  const shotId = typeof value?.id === "string" && value.id ? value.id : (idFactory?.() ?? randomId());
  const panels = Array.isArray(value?.panels)
    ? value.panels.map(panelSnapshot).filter((panel) => panel.id)
    : [];
  const dedupedPanels = [];
  const seen = new Set();
  for (const panel of panels) {
    if (seen.has(panel.id)) continue;
    seen.add(panel.id);
    dedupedPanels.push(panel);
  }
  return {
    id: shotId,
    duration_sec: clampDuration(value?.duration_sec),
    panels: dedupedPanels,
  };
}

export function createScene(value = {}) {
  const shots = Array.isArray(value?.shots) ? value.shots.map((shot) => createSceneShot(shot)) : [];
  const seenShots = new Set();
  const dedupedShots = [];
  for (const shot of shots) {
    if (seenShots.has(shot.id)) continue;
    seenShots.add(shot.id);
    dedupedShots.push(shot);
  }
  const currentShotId = typeof value?.current_shot_id === "string" && seenShots.has(value.current_shot_id)
    ? value.current_shot_id
    : null;
  return {
    id: typeof value?.id === "string" ? value.id : null,
    name: typeof value?.name === "string" && value.name.trim() ? value.name.trim() : "New scene",
    loop: Boolean(value?.loop),
    default_duration_sec: clampDuration(value?.default_duration_sec),
    current_shot_id: currentShotId,
    shots: dedupedShots,
    updated_at: typeof value?.updated_at === "string" ? value.updated_at : null,
  };
}

export function captureShotFromPanels(panels, { durationSec, idFactory } = {}) {
  return createSceneShot(
    {
      id: idFactory?.(),
      duration_sec: clampDuration(durationSec),
      panels: (Array.isArray(panels) ? panels : [])
        .filter((panel) => !panel?.minimized)
        .map(panelSnapshot),
    },
    { idFactory },
  );
}

export function sceneShotPayload(scene) {
  const normalized = createScene(scene);
  return {
    loop: normalized.loop,
    default_duration_sec: normalized.default_duration_sec,
    current_shot_id: normalized.current_shot_id,
    shots: normalized.shots,
  };
}
