import { expect, test } from "@playwright/test";
import {
  DEPTH_PNG,
  clickSceneObject,
  createTinyWebm,
  holdSceneObject,
  mockServer,
  panelSurfaceScreenPoint,
  selectBeachImage,
  selectMediaEntry,
} from "./souvenir.fixtures.js";

const VIDEO_PATH = "albums/clip.webm";
const VIDEO_ENTRY = {
  name: "clip.webm",
  path: VIDEO_PATH,
  kind: "file",
  media_type: "video/webm",
  size: 2048,
  mtime: "2026-05-01T00:00:00Z",
  tag_ids: [],
  url: `/api/file?path=${encodeURIComponent(VIDEO_PATH)}`,
  thumbnail_url: `/api/thumbnail?path=${encodeURIComponent(VIDEO_PATH)}`,
};
const VIDEO_ACTIONS = ["toggle-video-playback", "seek-video-backward", "seek-video-forward"];
const PLAY_GLYPH = "⏵";
const PAUSE_GLYPH = "⏸";

test.beforeEach(async ({ page }) => {
  await mockServer(page);
});

async function openDesktopPreview(page) {
  await page.goto("/?debug=1");
  const album = page.locator('.directory-row input[value="albums"]');
  await expect(album).toBeVisible();
  await album.check();
  await expect(page.locator("#preview-button")).toBeEnabled();
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__souvenirApp?.panelViews?.size)))
    .toBe(true);
}

async function firstPanelId(page) {
  return page.evaluate(() => window.__souvenirApp.panelState.panels[0].id);
}

function optionsWindow(page, panelId = null) {
  const selector = panelId
    ? `.scene-options-window[data-panel-id="${panelId}"]`
    : ".scene-options-window";
  return page.locator(selector);
}

function inlineScale(transform) {
  const match = /scale\(([\d.]+)\)/.exec(String(transform ?? ""));
  return match ? Number(match[1]) : 1;
}

async function elementCenter(locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}

function panelControl(page, panelId, action) {
  return page.evaluate(({ id, target }) => {
    const control = window.__souvenirApp.panelViews
      .get(id)
      ?.controls.children.find((child) => child.userData.action === target);
    return control ? { visible: control.visible, label: control.userData.label } : null;
  }, { id: panelId, target: action });
}

function videoState(page, panelId) {
  return page.evaluate((id) => {
    const media = window.__souvenirApp.panelViews.get(id)?.mediaTexture;
    return media ? { playing: media.isPlaying(), currentTime: media.currentTime } : null;
  }, panelId);
}

test("shows a 2D options window in desktop preview and hides the in-scene chrome", async ({ page }) => {
  await openDesktopPreview(page);
  const panelId = await firstPanelId(page);

  await clickSceneObject(page, { action: "toggle-options", panelId });

  const window = optionsWindow(page);
  await expect(window).toBeVisible();
  await expect(window).toContainText("OPTIONS");
  await expect(window.locator('[data-action="toggle-mask"]')).toBeVisible();
  await expect(window.locator('[data-action="toggle-light-fx"]')).toBeVisible();

  for (const flag of ["optionsPanel.visible", "depthSlider.visible"]) {
    await expect
      .poll(() =>
        page.evaluate(({ id, flag }) => {
          const view = window.__souvenirApp.panelViews.get(id);
          return flag.split(".").reduce((object, key) => object?.[key], view);
        }, { id: panelId, flag }),
      )
      .toBe(false);
  }
});

test("tracks the focused panel: closing hides it, and another panel shows its own window", async ({ page }) => {
  await openDesktopPreview(page);
  const first = await firstPanelId(page);
  await clickSceneObject(page, { action: "add-panel" });
  await expect
    .poll(() => page.evaluate(() => window.__souvenirApp.panelState.panels.length))
    .toBe(2);
  const second = await page.evaluate(() => window.__souvenirApp.panelState.panels[1].id);
  // Keep the gear off the top-right Scene controls HUD: at x=0.8 the gear
  // projects onto the DOM overlay (~x 872..1262) and swallows the click.
  await page.evaluate((id) => window.__souvenirApp.store.setTransform(id, {
    position: { x: 0.1, y: 1.35, z: -1.45 },
    rotation: { x: 0, y: 0, z: 0 },
  }), second);
  // Unfocused panels hide their controls, so select a panel before clicking
  // its gear. In the app this happens through the same tap (the gear action
  // focuses its panel); the helper makes the setup step explicit.
  async function focusPanel(panelId) {
    await page.evaluate((id) => window.__souvenirApp.store.focus(id), panelId);
    await expect
      .poll(() => page.evaluate(() => window.__souvenirApp.panelState.focusedId))
      .toBe(panelId);
  }

  const windowA = optionsWindow(page, first);
  const windowB = optionsWindow(page, second);
  await expect(windowA).toBeHidden();
  await expect(windowB).toBeHidden();

  await focusPanel(first);
  await clickSceneObject(page, { action: "toggle-options", panelId: first });
  await expect(windowA).toBeVisible();
  await expect(windowB).toBeHidden();

  await focusPanel(second);
  await clickSceneObject(page, { action: "toggle-options", panelId: second });
  await expect(windowB).toBeVisible();
  await expect(windowA).toBeHidden();

  await windowB.locator('[aria-label="Close options"]').click();
  await expect(windowB).toBeHidden();

  await clickSceneObject(page, { action: "toggle-options", panelId: second });
  await expect(windowB).toBeVisible();
});

test("remembers the dragged position while previewing", async ({ page }) => {
  await openDesktopPreview(page);
  const panelId = await firstPanelId(page);

  await clickSceneObject(page, { action: "toggle-options", panelId });
  const window = optionsWindow(page);
  await expect(window).toBeVisible();
  const before = await window.boundingBox();
  expect(before).not.toBeNull();

  await page.mouse.move(before.x + 80, before.y + 12);
  await page.mouse.down();
  await page.mouse.move(before.x + 260, before.y + 24, { steps: 8 });
  await page.mouse.up();

  const dragged = await window.boundingBox();
  expect(dragged).not.toBeNull();
  expect(dragged.x).toBeGreaterThan(before.x + 40);

  await window.locator('[aria-label="Close options"]').click();
  await expect(window).toBeHidden();

  await clickSceneObject(page, { action: "toggle-options", panelId });
  await expect(window).toBeVisible();
  const reopened = await window.boundingBox();
  expect(reopened).not.toBeNull();
  expect(Math.round(reopened.x)).toBe(Math.round(dragged.x));
  expect(Math.round(reopened.y)).toBe(Math.round(dragged.y));
});

test("keeps the tag list collapsed until the toggle is used", async ({ page }) => {
  await page.unroute("**/api/**");
  await mockServer(page, {
    tagServer: {
      tags: [{ id: "horse", name: "Horse" }, { id: "blue", name: "Blue" }],
      assignments: new Map(),
      requests: [],
      nextId: 1,
    },
  });
  await openDesktopPreview(page);
  const panelId = await firstPanelId(page);

  await clickSceneObject(page, { action: "toggle-options", panelId });
  const window = optionsWindow(page);
  await expect(window).toBeVisible();

  const toggle = window.locator('[data-action="toggle-tag-list"]');
  await expect(toggle).toHaveText("Tags \u25b8");
  await expect(window.locator('[data-action^="toggle-media-tag:"]')).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveText("Tags \u25be");
  await expect(window.locator('[data-action="toggle-media-tag:horse"]')).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveText("Tags \u25b8");
  await expect(window.locator('[data-action^="toggle-media-tag:"]')).toHaveCount(0);
});

test("keeps the options window attached to its panel", async ({ page }) => {
  await openDesktopPreview(page);
  const panelId = await firstPanelId(page);

  await clickSceneObject(page, { action: "toggle-options", panelId });
  const window = optionsWindow(page);
  await expect(window).toBeVisible();

  const anchor = () => page.evaluate((id) => {
    const app = window.__souvenirApp;
    const view = app.panelViews.get(id);
    const options = view.optionsWindow;
    view.updateMatrixWorld(true);
    const point = view.position.clone().set(0, 0, 0).applyMatrix4(view.matrixWorld).project(app.camera);
    const host = options.host.getBoundingClientRect();
    return {
      anchorX: ((point.x + 1) / 2) * host.width,
      anchorY: ((1 - point.y) / 2) * host.height,
      offset: options.getOffset(),
      left: parseFloat(options.element.style.left),
      top: parseFloat(options.element.style.top),
    };
  }, panelId);

  // The window is drawn at a free offset from its panel, never on top of it.
  const initial = await anchor();
  expect(initial.offset.x).toBeGreaterThan(0);
  expect(initial.left - initial.anchorX).toBeCloseTo(initial.offset.x, 0);
  expect(initial.top - initial.anchorY).toBeCloseTo(initial.offset.y, 0);

  // Dragging the title bar moves the window and changes only the offset.
  const box = await window.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 70, { steps: 8 });
  await page.mouse.up();
  const dragged = await anchor();
  expect(dragged.offset.x - initial.offset.x).toBeCloseTo(80, 0);
  expect(dragged.offset.y - initial.offset.y).toBeCloseTo(60, 0);
  expect(dragged.left - dragged.anchorX).toBeCloseTo(dragged.offset.x, 0);
  expect(dragged.top - dragged.anchorY).toBeCloseTo(dragged.offset.y, 0);

  // Moving the panel carries the window without changing that offset. The panel
  // is pushed far enough right that the window has to stay on screen instead.
  const movePanel = (x) => page.evaluate(({ id, x }) => window.__souvenirApp.store.setTransform(id, {
    position: { x, y: 1.35, z: -1.45 },
    rotation: { x: 0, y: 0, z: 0 },
  }), { id: panelId, x });

  await movePanel(0.45);
  await expect.poll(async () => (await anchor()).left).toBeGreaterThan(dragged.left + 20);
  const moved = await anchor();
  expect(moved.offset.x).toBeCloseTo(dragged.offset.x, 5);
  expect(moved.offset.y).toBeCloseTo(dragged.offset.y, 5);
  expect(moved.left).toBeLessThanOrEqual(1280 - 320 - 8);
  expect(moved.left).toBeGreaterThanOrEqual(8);

  // Moving the panel back restores the dragged placement exactly.
  await movePanel(0);
  await expect.poll(async () => (await anchor()).left).toBeCloseTo(dragged.left, 0);
  const restored = await anchor();
  expect(restored.offset.x).toBeCloseTo(dragged.offset.x, 5);
  expect(restored.offset.y).toBeCloseTo(dragged.offset.y, 5);
  expect(restored.left - restored.anchorX).toBeCloseTo(restored.offset.x, 0);
  expect(restored.top - restored.anchorY).toBeCloseTo(restored.offset.y, 0);
});

test("applies lighting actions from the window and highlights the selection", async ({ page }) => {
  await page.unroute("**/api/**");
  await mockServer(page, {
    depthServer: {
      maps: new Map([["albums/beach.jpg", { png: DEPTH_PNG, updatedAt: "2026-08-25T00:00:00Z" }]]),
      requests: [],
    },
    admServer: {
      settings: new Map([
        ["albums/beach.jpg", { configured: true, enabled: true, depth_intensity: 0.5 }],
      ]),
      requests: [],
    },
  });
  await openDesktopPreview(page);
  const panelId = await firstPanelId(page);

  await selectBeachImage(page, panelId);
  await clickSceneObject(page, { action: "toggle-options", panelId });
  const window = optionsWindow(page);
  await expect(window).toBeVisible();

  await window.locator('[data-action="set-ambient-color:gold"]').click();
  await expect
    .poll(() =>
      page.evaluate((id) => window.__souvenirApp.panelViews.get(id)?.ambientColor, panelId),
    )
    .toBe("gold");
  await expect(window.locator('[data-action="set-ambient-color:gold"]')).toHaveClass(/is-active/);

  await window.locator('[data-action="set-light-direction:top"]').click();
  await expect
    .poll(() =>
      page.evaluate((id) => window.__souvenirApp.panelViews.get(id)?.lightDirection, panelId),
    )
    .toBe("top");
  await expect(window.locator('[data-action="set-light-direction:top"]')).toHaveClass(/is-active/);
});

test("selects persisted tag slideshow mode from panel options", async ({ page }) => {
  await page.unroute("**/api/**");
  await mockServer(page, {
    tagServer: {
      tags: [{ id: "horse", name: "Horse" }, { id: "blue", name: "Blue" }],
      assignments: new Map(),
      requests: [],
      nextId: 1,
    },
  });
  await openDesktopPreview(page);
  const panelId = await firstPanelId(page);
  await clickSceneObject(page, { action: "toggle-options", panelId });
  const window = optionsWindow(page);

  await expect(window.locator(".scene-options-window__slideshow-mode")).toBeVisible();
  await window.locator('[data-action="set-slideshow-mode:tag"]').click();
  await expect
    .poll(() => page.evaluate((id) => window.__souvenirApp.panelState.panels
      .find((panel) => panel.id === id)?.slideshowMode, panelId))
    .toBe("tag");
  await expect(window.locator('[data-action="set-slideshow-mode:tag"]')).toHaveClass(/is-active/);
});

test("mouse wheel over the title bar rescales the options window 2D", async ({ page }) => {
  await openDesktopPreview(page);
  const panelId = await firstPanelId(page);

  await clickSceneObject(page, { action: "toggle-options", panelId });
  const window = optionsWindow(page);
  await expect(window).toBeVisible();
  expect(inlineScale(await window.evaluate((el) => el.style.transform))).toBe(1);

  const titlebar = window.locator(".scene-options-window__titlebar");
  const titlebarCenter = await elementCenter(titlebar);
  await page.mouse.move(titlebarCenter.x, titlebarCenter.y);
  await page.mouse.wheel(0, -240);

  await expect
    .poll(async () => inlineScale(await window.evaluate((el) => el.style.transform)))
    .toBeGreaterThan(1);

  // Wheel over the body is left untouched so it can keep scrolling the list.
  const bodyCenter = await elementCenter(window.locator(".scene-options-window__body"));
  await page.mouse.move(bodyCenter.x, bodyCenter.y);
  const beforeBody = inlineScale(await window.evaluate((el) => el.style.transform));
  await page.mouse.wheel(0, 480);
  const afterBody = inlineScale(await window.evaluate((el) => el.style.transform));
  expect(afterBody).toBe(beforeBody);

  // The window zooms around its center, so the title bar has moved since it
  // was measured at scale 1; re-measure before rolling the wheel down.
  const titlebarCenterScaled = await elementCenter(titlebar);
  await page.mouse.move(titlebarCenterScaled.x, titlebarCenterScaled.y);
  await page.mouse.wheel(0, 480);
  await expect
    .poll(async () => inlineScale(await window.evaluate((el) => el.style.transform)))
    .toBeLessThan(beforeBody);
});

test("hover never selects: only a tap moves the toolbar and options", async ({ page }) => {
  await openDesktopPreview(page);
  const first = await firstPanelId(page);
  await clickSceneObject(page, { action: "add-panel" });
  await expect
    .poll(() => page.evaluate(() => window.__souvenirApp.panelState.panels.length))
    .toBe(2);
  const second = await page.evaluate(() => window.__souvenirApp.panelState.panels[1].id);
  // The clone lands on top of the first panel; separate them so the ray hits
  // exactly one surface. The new panel starts selected, so its gear is the
  // visible one.
  await page.evaluate((id) => window.__souvenirApp.store.setTransform(id, {
    position: { x: -0.9, y: 1.35, z: -1.45 },
    rotation: { x: 0, y: 0, z: 0 },
  }), first);

  await clickSceneObject(page, { action: "toggle-options", panelId: second });
  const windowB = optionsWindow(page, second);
  await expect(windowB).toBeVisible();

  const surfacePoint = await panelSurfaceScreenPoint(page, first);

  // Hover without clicking: selection, toolbar, and options must not move.
  await page.mouse.move(surfacePoint.x, surfacePoint.y);
  await page.waitForTimeout(250);
  await expect
    .poll(() => page.evaluate(() => window.__souvenirApp.panelState.focusedId))
    .toBe(second);
  await expect(windowB).toBeVisible();
  await expect
    .poll(() => page.evaluate((id) => window.__souvenirApp.panelViews.get(id)?.controls.visible, first))
    .toBe(false);

  // A real tap on the other panel selects it and fully closes the old window.
  await page.mouse.click(surfacePoint.x, surfacePoint.y);
  await expect
    .poll(() => page.evaluate(() => window.__souvenirApp.panelState.focusedId), { timeout: 5000 })
    .toBe(first);
  await expect(windowB).toBeHidden();
  await expect
    .poll(() => page.evaluate((id) => window.__souvenirApp.panelViews.get(id)?.optionsOpen, second))
    .toBe(false);
  await expect
    .poll(() => page.evaluate((id) => window.__souvenirApp.panelViews.get(id)?.controls.visible, first))
    .toBe(true);
  await expect
    .poll(() => page.evaluate((id) => window.__souvenirApp.panelViews.get(id)?.controls.visible, second))
    .toBe(false);
});

test("moves and rescales the in-scene options chrome with panel-style gestures", async ({ page }) => {
  await openDesktopPreview(page);
  const panelId = await firstPanelId(page);

  // Dispatch through the same interaction target the XR controller calls for a
  // grab on the options window.
  const optionsGesture = (gesture) => page.evaluate(({ id, payload }) => {
    window.__souvenirApp.panelViews.get(id).optionsPanel.interactionTarget.onGesture(payload);
  }, { id: panelId, payload: gesture });
  const optionsState = () => page.evaluate((id) => {
    const panel = window.__souvenirApp.panelViews.get(id).optionsPanel;
    return {
      scale: panel.scale.x,
      x: panel.position.x,
      y: panel.position.y,
      z: panel.position.z,
      rotation: panel.quaternion.toArray(),
    };
  }, panelId);

  const placed = await optionsState();

  // An absolute two-hand pose rescales and places the window.
  await optionsGesture({
    hands: 2,
    absolutePose: { position: { x: placed.x + 0.2, y: placed.y - 0.1, z: placed.z } },
    absoluteObjectScale: 1.5,
  });
  let state = await optionsState();
  expect(state.scale).toBeCloseTo(1.5);
  expect(state.x).toBeCloseTo(placed.x + 0.2);
  expect(state.y).toBeCloseTo(placed.y - 0.1);

  // A wide pinch clamps to the shared upper bound.
  await optionsGesture({
    hands: 2,
    absolutePose: { position: { x: state.x, y: state.y, z: state.z } },
    absoluteObjectScale: 3,
  });
  state = await optionsState();
  expect(state.scale).toBeCloseTo(2.2);

  // The window stays billboarded, so a rotation in the gesture is ignored.
  await optionsGesture({
    hands: 1,
    absolutePose: { position: { x: state.x, y: state.y, z: state.z } },
    rotation: { x: 0.4, y: 0, z: 0 },
  });
  expect((await optionsState()).rotation).toEqual(state.rotation);

  // Without an absolute pose the gesture falls back to incremental deltas.
  await optionsGesture({
    hands: 1,
    translation: { x: 0.1, y: -0.05, z: 0 },
    rotation: { x: 0.4, y: 0, z: 0 },
  });
  state = await optionsState();
  expect(state.x).toBeCloseTo(placed.x + 0.3);
  expect(state.y).toBeCloseTo(placed.y - 0.15);
  expect(state.scale).toBeCloseTo(2.2);

  // A further panel state change must not move the window back to its default.
  await page.evaluate((id) => window.__souvenirApp.store.setSaveMode(id, "full"), panelId);
  state = await optionsState();
  expect(state.x).toBeCloseTo(placed.x + 0.3);
  expect(state.y).toBeCloseTo(placed.y - 0.15);
});

test("captures, restores, updates, and clears scene snapshots", async ({ page }) => {
  await openDesktopPreview(page);
  const panelId = await firstPanelId(page);

  const setPosition = (x) => page.evaluate(({ id, x }) => {
    window.__souvenirApp.store.setTransform(id, {
      position: { x, y: 1.35, z: -1.45 },
      rotation: { x: 0, y: 0, z: 0 },
    });
  }, { id: panelId, x });
  const panelX = () =>
    page.evaluate(() => window.__souvenirApp.panelState.panels[0].transform.position.x);

  await setPosition(0.2);
  await clickSceneObject(page, { action: "capture-snapshot" });
  await expect
    .poll(() => page.evaluate(() => window.__souvenirApp.snapshotController.getSelectedIndex()))
    .toBe(0);
  await expect
    .poll(() => page.evaluate(() => window.__souvenirApp.snapshotController.getSlots().filter(Boolean).length))
    .toBe(1);

  // Move the panel, then rebuild the scene from the captured slot.
  await setPosition(-0.4);
  await clickSceneObject(page, { action: "select-snapshot:0" });
  await expect.poll(panelX).toBeCloseTo(0.2, 5);

  // Capturing again while the slot is selected overwrites it.
  await setPosition(0.5);
  await clickSceneObject(page, { action: "capture-snapshot" });
  await expect
    .poll(() => page.evaluate(() => window.__souvenirApp.snapshotController.getSlots()[0].panels[0].transform.position.x))
    .toBeCloseTo(0.5, 5);

  // A press-and-hold on the filled slot clears it.
  await holdSceneObject(page, { action: "select-snapshot:0" });
  await expect
    .poll(() => page.evaluate(() => window.__souvenirApp.snapshotController.getSlots()[0]))
    .toBe(null);
  await expect
    .poll(() => page.evaluate(() => window.__souvenirApp.snapshotController.getSelectedIndex()))
    .toBe(null);
});

test("drives video playback and 15 second skips from the panel toolbar", async ({ page }) => {
  // The shared mock has no video in the library, so swap in one that serves a
  // real decodable WebM for both the file and the poster request.
  await page.unroute("**/api/**");
  const videoFixtures = {};
  await mockServer(page, { extraEntries: { albums: [VIDEO_ENTRY] }, videoFixtures });
  videoFixtures[VIDEO_PATH] = await createTinyWebm(page, 2);

  await openDesktopPreview(page);
  const panelId = await firstPanelId(page);

  // An image panel offers no movie controls.
  await selectBeachImage(page, panelId);
  await expect
    .poll(() => page.evaluate((id) => window.__souvenirApp.panelViews.get(id)?.mediaType, panelId))
    .toBe("image");
  for (const action of VIDEO_ACTIONS) {
    expect((await panelControl(page, panelId, action))?.visible).toBe(false);
  }

  await selectMediaEntry(page, panelId, VIDEO_PATH);
  await expect
    .poll(() => page.evaluate((id) => window.__souvenirApp.panelViews.get(id)?.mediaType, panelId))
    .toBe("video");
  for (const action of VIDEO_ACTIONS) {
    expect((await panelControl(page, panelId, action))?.visible).toBe(true);
  }
  expect((await panelControl(page, panelId, "toggle-video-playback"))?.label).toBe(PLAY_GLYPH);

  await clickSceneObject(page, { action: "toggle-video-playback", panelId });
  await expect.poll(async () => (await videoState(page, panelId))?.playing).toBe(true);
  await expect
    .poll(async () => (await panelControl(page, panelId, "toggle-video-playback"))?.label)
    .toBe(PAUSE_GLYPH);

  await clickSceneObject(page, { action: "toggle-video-playback", panelId });
  await expect.poll(async () => (await videoState(page, panelId))?.playing).toBe(false);
  await expect
    .poll(async () => (await panelControl(page, panelId, "toggle-video-playback"))?.label)
    .toBe(PLAY_GLYPH);

  // A skip clamps to the media bounds: forward reaches the end of this short
  // clip, backward returns to the start. The 15 second step itself is covered
  // by the renderer-independent unit tests.
  await clickSceneObject(page, { action: "seek-video-forward", panelId });
  await expect
    .poll(async () => (await videoState(page, panelId))?.currentTime)
    .toBeGreaterThan(0);
  await clickSceneObject(page, { action: "seek-video-backward", panelId });
  await expect
    .poll(async () => (await videoState(page, panelId))?.currentTime)
    .toBe(0);

  // Going back to an image removes the movie controls from the row again.
  await selectBeachImage(page, panelId);
  await expect
    .poll(() => page.evaluate((id) => window.__souvenirApp.panelViews.get(id)?.mediaType, panelId))
    .toBe("image");
  for (const action of VIDEO_ACTIONS) {
    expect((await panelControl(page, panelId, action))?.visible).toBe(false);
  }
});
