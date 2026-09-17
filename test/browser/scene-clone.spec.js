import { expect, test } from "@playwright/test";
import {
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

test("clone-panel duplicates the media and settings to the side", async ({ page }) => {
  await openDesktopPreview(page);
  const sourceId = await page.evaluate(() => window.__souvenirApp.panelState.panels[0].id);
  await selectBeachImage(page, sourceId);
  await page.evaluate((id) => {
    const app = window.__souvenirApp;
    app.store.setSort(id, "mtime");
    app.store.setPose(id, {
      transform: {
        position: { x: -0.4, y: 1.3, z: -1.4 },
        rotation: { x: 0, y: 0, z: 0 },
      },
      dimensions: { width: 1, height: 0.7 },
    });
  }, sourceId);

  const sourceBefore = await page.evaluate((id) => {
    const panel = window.__souvenirApp.panelState.panels.find((item) => item.id === id);
    return {
      media: { ...panel.media },
      dimensions: { ...panel.dimensions },
      position: { ...panel.transform.position },
    };
  }, sourceId);

  // The clone control sits immediately before the options gear in the icon bar.
  const actionOrder = await page.evaluate((id) => (
    window.__souvenirApp.panelViews.get(id)?.controls.children.map((child) => child.userData.action) ?? []
  ), sourceId);
  expect(actionOrder[actionOrder.indexOf("clone-panel") + 1]).toBe("toggle-options");

  await clickSceneObject(page, { action: "clone-panel", panelId: sourceId });
  await expect
    .poll(() => page.evaluate(() => window.__souvenirApp.panelState.panels.length))
    .toBe(2);

  const state = await page.evaluate(() => {
    const { panels, focusedId } = window.__souvenirApp.store.getState();
    return { panels, focusedId };
  });
  const clone = state.panels.find((panel) => panel.id !== sourceId);
  expect(clone).toBeTruthy();
  expect(clone.media).toMatchObject(sourceBefore.media);
  expect(clone.dimensions).toEqual(sourceBefore.dimensions);
  expect(clone.transform.position.x).toBeCloseTo(
    sourceBefore.position.x + sourceBefore.dimensions.width + 0.15, 5,
  );
  expect(clone.transform.position.y).toBe(sourceBefore.position.y);
  expect(clone.transform.position.z).toBe(sourceBefore.position.z);
  expect(clone.minimized).toBe(false);
  expect(clone.locked).toBe(false);
  expect(state.focusedId).toBe(clone.id);

  // The clone resolves the same media through its copied playlist.
  await expect
    .poll(() => page.evaluate((id) => (
      window.__souvenirApp.panelCoordinator.runtimeFor(id).playlist
        .some((item) => (item.path ?? item.id) === "albums/beach.jpg")
    ), clone.id))
    .toBe(true);
});
