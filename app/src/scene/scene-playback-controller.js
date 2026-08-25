import {
  captureShotFromPanels,
  createScene,
  sceneShotPayload,
} from "../core/index.js";

const DEFAULT_SCENE_NAME = "New scene";

// Owns scene CRUD, shot persistence, playback timing, and panel transitions.
export class ScenePlaybackController {
  constructor({
    api,
    getPanels,
    applyPanelSnapshot,
    removePanel,
    applyPanelTransition,
    clearPanelTransition,
    onStateChange,
    onError,
    now = () => performance.now(),
  }) {
    this.api = api;
    this.getPanels = getPanels;
    this.applyPanelSnapshot = applyPanelSnapshot;
    this.removePanel = removePanel;
    this.applyPanelTransition = applyPanelTransition;
    this.clearPanelTransition = clearPanelTransition;
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.now = now;
    this.scene = createScene({ id: null, name: DEFAULT_SCENE_NAME, loop: true });
    this.playbackActive = false;
    this.nextAdvanceAt = null;
    this.transition = null;
    this.disposed = false;
  }

  getState() {
    const selectedIndex = this.scene.shots.findIndex(
      (shot) => shot.id === this.scene.current_shot_id,
    );
    const selectedShot = selectedIndex >= 0 ? this.scene.shots[selectedIndex] : null;
    return {
      ...this.scene,
      selected_shot_index: selectedIndex,
      selected_shot_duration_sec: selectedShot?.duration_sec ?? this.scene.default_duration_sec,
      playback_active: this.playbackActive,
      can_delete_selected_shot: this.canDeleteSelectedShot(),
    };
  }

  emitState() {
    if (!this.disposed) this.onStateChange?.(this.getState());
  }

  compositionChanged() {
    this.emitState();
  }

  async list() {
    const payload = await this.api.scenes();
    return Array.isArray(payload?.scenes) ? payload.scenes : [];
  }

  async create(name) {
    const created = createScene(await this.api.createScene(name));
    const draftPayload = sceneShotPayload(this.scene);
    this.scene = createScene({
      ...created,
      ...draftPayload,
      id: created.id,
      name: created.name,
    });
    if (this.scene.shots.length > 0) {
      this.scene = createScene(await this.api.saveScene(created.id, sceneShotPayload(this.scene)));
    }
    this.resetPlayback();
    this.emitState();
    return this.getState();
  }

  async load(sceneId) {
    const loaded = createScene(await this.api.scene(sceneId));
    this.scene = loaded;
    this.resetPlayback();
    if (loaded.current_shot_id) {
      await this.applyShot(loaded.current_shot_id, { animate: false, persist: false });
    } else if (loaded.shots.length > 0) {
      await this.applyShot(loaded.shots[0].id, { animate: false, persist: false });
    }
    this.emitState();
    return this.getState();
  }

  reset() {
    this.scene = createScene({ id: null, name: DEFAULT_SCENE_NAME, loop: true });
    this.resetPlayback();
    this.emitState();
    return this.getState();
  }

  async setLoop(loop) {
    this.scene = createScene({ ...this.scene, loop: Boolean(loop) });
    await this.persist();
    this.emitState();
    return this.getState();
  }

  async setShotDuration(durationSec) {
    const selectedIndex = this.scene.shots.findIndex(
      (shot) => shot.id === this.scene.current_shot_id,
    );
    if (selectedIndex < 0) {
      this.scene = createScene({ ...this.scene, default_duration_sec: durationSec });
      await this.persist();
      this.emitState();
      return this.getState();
    }
    const shots = this.scene.shots.map((shot, index) => (
      index === selectedIndex ? { ...shot, duration_sec: durationSec } : shot
    ));
    this.scene = createScene({ ...this.scene, shots });
    await this.persist();
    this.emitState();
    return this.getState();
  }

  async selectShot(index) {
    const resolved = Number.isInteger(index) ? index : -1;
    if (resolved < 0 || resolved >= this.scene.shots.length) return this.getState();
    await this.applyShot(this.scene.shots[resolved].id, { animate: true, persist: true });
    this.emitState();
    return this.getState();
  }

  async togglePlayback() {
    if (this.scene.shots.length === 0) return this.getState();
    this.playbackActive = !this.playbackActive;
    const selectedShot = this.scene.shots.find(
      (shot) => shot.id === this.scene.current_shot_id,
    ) ?? this.scene.shots[0];
    if (!this.scene.current_shot_id) {
      await this.applyShot(selectedShot.id, { animate: true, persist: true });
    }
    this.nextAdvanceAt = this.playbackActive && selectedShot
      ? this.now() + selectedShot.duration_sec * 1000
      : null;
    this.emitState();
    return this.getState();
  }

  async captureOrDeleteShot() {
    if (this.canDeleteSelectedShot()) {
      const selectedIndex = this.scene.shots.findIndex(
        (shot) => shot.id === this.scene.current_shot_id,
      );
      const nextShots = this.scene.shots.filter((_, index) => index !== selectedIndex);
      const nextCurrent = nextShots[Math.max(0, selectedIndex - 1)]?.id ?? null;
      this.scene = createScene({
        ...this.scene,
        shots: nextShots,
        current_shot_id: nextCurrent,
      });
      if (nextCurrent) {
        await this.applyShot(nextCurrent, { animate: false, persist: false });
      }
      await this.persist();
      this.emitState();
      return this.getState();
    }
    const shot = this.currentPanelSnapshot(this.getState().selected_shot_duration_sec);
    this.scene = createScene({
      ...this.scene,
      shots: [...this.scene.shots, shot],
      current_shot_id: shot.id,
    });
    await this.persist();
    this.emitState();
    return this.getState();
  }

  currentPanelSnapshot(durationSec = this.scene.default_duration_sec) {
    return captureShotFromPanels(this.getPanels(), { durationSec });
  }

  canDeleteSelectedShot() {
    const selected = this.scene.shots.find((shot) => shot.id === this.scene.current_shot_id);
    if (!selected) return false;
    const current = this.currentPanelSnapshot(selected.duration_sec);
    return JSON.stringify(selected.panels) === JSON.stringify(current.panels)
      && selected.duration_sec === current.duration_sec;
  }

  async persist() {
    if (!this.scene.id) return;
    const saved = await this.api.saveScene(this.scene.id, sceneShotPayload(this.scene));
    this.scene = createScene(saved);
  }

  async applyShot(shotId, { animate = true, persist = true } = {}) {
    const shot = this.scene.shots.find((item) => item.id === shotId);
    if (!shot) return false;
    this.startTransition(shot, animate ? shot.duration_sec * 1000 : 0);
    this.scene = createScene({ ...this.scene, current_shot_id: shot.id });
    if (persist) await this.persist();
    this.nextAdvanceAt = this.now() + shot.duration_sec * 1000;
    return true;
  }

  snapshotPanelsById() {
    const snapshot = new Map();
    for (const panel of this.getPanels()) {
      snapshot.set(panel.id, {
        id: panel.id,
        media: {
          directory: panel.media?.directory ?? null,
          selectedId: panel.media?.selectedId ?? null,
          sort: panel.media?.sort ?? "name",
          view: panel.media?.view ?? "thumbnails",
        },
        transform: {
          position: { ...panel.transform.position },
          rotation: { ...panel.transform.rotation },
        },
        dimensions: { ...panel.dimensions },
      });
    }
    return snapshot;
  }

  startTransition(shot, durationMs) {
    const before = this.snapshotPanelsById();
    const target = new Map(shot.panels.map((panel) => [panel.id, panel]));
    for (const panel of shot.panels) this.applyPanelSnapshot(panel);
    const transitions = new Map();
    const removeAtEnd = [];
    const allPanelIds = new Set([...before.keys(), ...target.keys()]);
    for (const panelId of allPanelIds) {
      const from = before.get(panelId) ?? target.get(panelId);
      const to = target.get(panelId) ?? before.get(panelId);
      if (!from || !to) continue;
      const entering = !before.has(panelId) && target.has(panelId);
      const leaving = before.has(panelId) && !target.has(panelId);
      transitions.set(panelId, {
        from,
        to,
        fromAlpha: entering ? 0 : 1,
        toAlpha: leaving ? 0 : 1,
      });
      if (leaving) removeAtEnd.push(panelId);
    }
    this.transition = {
      startedAt: this.now(),
      durationMs: Math.max(0, Number(durationMs) || 0),
      transitions,
      removeAtEnd,
    };
    if (this.transition.durationMs === 0) this.updateTransition(this.now());
  }

  updateTransition(time) {
    if (!this.transition) return;
    const progress = this.transition.durationMs <= 0
      ? 1
      : Math.max(0, Math.min(1, (time - this.transition.startedAt) / this.transition.durationMs));
    for (const [panelId, step] of this.transition.transitions) {
      this.applyPanelTransition(panelId, step, progress);
    }
    if (progress < 1) return;
    for (const panelId of this.transition.removeAtEnd) this.removePanel(panelId);
    for (const panelId of this.transition.transitions.keys()) this.clearPanelTransition(panelId);
    this.transition = null;
  }

  advancePlayback(time) {
    if (
      !this.playbackActive
      || !Number.isFinite(this.nextAdvanceAt)
      || this.scene.shots.length < 1
      || time < this.nextAdvanceAt
    ) {
      return;
    }
    const currentIndex = this.scene.shots.findIndex(
      (shot) => shot.id === this.scene.current_shot_id,
    );
    if (currentIndex < 0) {
      this.playbackActive = false;
      this.nextAdvanceAt = null;
      this.emitState();
      return;
    }
    const nextIndex = currentIndex + 1;
    if (nextIndex >= this.scene.shots.length && !this.scene.loop) {
      this.playbackActive = false;
      this.nextAdvanceAt = null;
      this.emitState();
      return;
    }
    const nextShot = this.scene.shots[nextIndex] ?? this.scene.shots[0];
    this.applyShot(nextShot.id, { animate: true, persist: false })
      .then(() => this.emitState())
      .catch((error) => {
        this.onError?.(new Error(`Could not advance scene playback: ${error.message}`));
      });
  }

  resetPlayback() {
    this.playbackActive = false;
    this.nextAdvanceAt = null;
    this.transition = null;
  }

  stop() {
    this.resetPlayback();
  }

  dispose() {
    this.stop();
    this.disposed = true;
  }
}
