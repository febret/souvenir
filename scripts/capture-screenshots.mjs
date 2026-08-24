import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium } from "@playwright/test";

const baseUrl = process.env.SOUVENIR_SCREENSHOT_URL ?? "http://127.0.0.1:8000";
const output = resolve("doc/images");

async function scenePoint(page, matcher) {
  return page.evaluate((matcher) => {
    const app = window.__souvenirApp;
    let target = null;
    app.scene.traverse((object) => {
      if (target) return;
      const matches = Object.entries(matcher).every(([key, value]) => {
        if (key === "entryPath") return object.userData.entry?.path === value;
        return object.userData[key] === value;
      });
      if (matches) target = object;
    });
    if (!target) return null;
    const vector = target.position.clone();
    target.getWorldPosition(vector);
    vector.project(app.camera);
    const bounds = app.canvas.getBoundingClientRect();
    return {
      x: bounds.left + ((vector.x + 1) / 2) * bounds.width,
      y: bounds.top + ((1 - vector.y) / 2) * bounds.height,
    };
  }, matcher);
}

async function clickScene(page, matcher) {
  const point = await scenePoint(page, matcher);
  if (!point) throw new Error(`Scene control was not found: ${JSON.stringify(matcher)}`);
  await page.mouse.click(point.x, point.y);
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
await page.goto(`${baseUrl}/?debug=1`);
await page.locator("#connection-status").getByText("Local server").waitFor();
await page.screenshot({ path: resolve(output, "home.png"), fullPage: true });

const trips = page.locator('.directory-row input[value="Trips"]');
if (await trips.count()) await trips.check();
await page.locator("#preview-button").click();
await page.waitForFunction(() => window.__souvenirApp?.store);
const panelId = await page.evaluate(() => window.__souvenirApp.store.getState().focusedId);
await clickScene(page, { action: "browse", panelId });
await page.waitForFunction(() => window.__souvenirApp.browser?.entries.length > 0);
await clickScene(page, { action: "browser-view" });
await page.waitForTimeout(500);
await page.screenshot({ path: resolve(output, "media-browser.png") });

await clickScene(page, { kind: "browser-entry", entryPath: "Trips/lake.jpg" });
await page.waitForFunction(
  () => window.__souvenirApp.store.getState().panels[0].media.selectedId === "Trips/lake.jpg",
);
await page.waitForTimeout(700);
await page.screenshot({ path: resolve(output, "xr-preview.png") });
await browser.close();
