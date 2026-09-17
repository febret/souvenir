import { expect, test } from "@playwright/test";
import {
  DEPTH_PNG,
  clickSceneObject,
  mockServer,
  selectBeachImage,
} from "./souvenir.fixtures.js";

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

async function optionsScale(page, panelId) {
  return page.evaluate((id) => window.__souvenirApp.panelViews.get(id)?.optionsPanel.scale.x, panelId);
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
  // Unfocused panels hide their controls, so focus a panel before clicking its
  // gear (the same interaction as pointing at it in XR).
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

test("scales the in-scene options chrome from a two-hand gesture", async ({ page }) => {
  await openDesktopPreview(page);
  const panelId = await firstPanelId(page);

  // Dispatch through the same callback the XR interaction controller uses for
  // a two-hand pinch on the options backdrop.
  await page.evaluate((id) => {
    window.__souvenirApp.panelViews.get(id).optionsPanel.dragTarget.onGesture({
      hands: 2,
      scale: 1.5,
    });
  }, panelId);
  await expect.poll(() => optionsScale(page, panelId)).toBe(1.5);

  // A wide pinch clamps to the shared upper bound.
  await page.evaluate((id) => {
    window.__souvenirApp.panelViews.get(id).optionsPanel.dragTarget.onGesture({
      hands: 2,
      scale: 3,
    });
  }, panelId);
  await expect.poll(() => optionsScale(page, panelId)).toBe(2.2);

  // One-hand drag still translates instead of scaling.
  await page.evaluate((id) => {
    const view = window.__souvenirApp.panelViews.get(id);
    view.optionsPanel.dragTarget.onGesture({
      hands: 1,
      translation: { x: 0.1, y: -0.05, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    });
  }, panelId);
  const offset = await page.evaluate((id) => {
    const view = window.__souvenirApp.panelViews.get(id);
    return { ...view.optionsOffset };
  }, panelId);
  expect(offset.x).toBeCloseTo(0.1);
  expect(offset.y).toBeCloseTo(-0.05);
});