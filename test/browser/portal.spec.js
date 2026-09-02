import { expect, test } from "@playwright/test";
import {
  directoryCheckbox,
  directoryRow,
  disclosureButton,
  expandDirectory,
  expectVisibleDirectoryPaths,
  mockServer,
} from "./souvenir.fixtures.js";

test.beforeEach(async ({ page }) => {
  await mockServer(page);
});

test("configures folders and playback with persistent settings", async ({ page }) => {
  await page.goto("/?debug=1");

  await expect(page.getByRole("heading", { name: "Souvenir", exact: true })).toBeVisible();
  await expect(page.locator("#connection-status")).toHaveText("Local server");
  const album = page.locator('.directory-row input[value="albums"]');
  await expect(album).toBeVisible();
  await album.check();
  await page.locator("#autoplay").check();
  await page.locator("#slideshow-speed").fill("12");
  await page.locator("#caption-size").fill("1.4");
  await page.locator("#caption-transparency").fill("0.25");
  await page.locator("#caption-distance").fill("1.8");
  await expect(page.locator("#slideshow-value")).toHaveText("12 sec");
  await expect(page.locator("#caption-size-value")).toHaveText("140%");
  await expect(page.locator("#caption-transparency-value")).toHaveText("25%");
  await expect(page.locator("#caption-distance-value")).toHaveText("1.8 m");

  await page.reload();
  await expect(page.locator('.directory-row input[value="albums"]')).toBeChecked();
  await expect(page.locator("#autoplay")).toBeChecked();
  await expect(page.locator("#slideshow-speed")).toHaveValue("12");
  await expect(page.locator("#caption-size")).toHaveValue("1.4");
  await expect(page.locator("#caption-transparency")).toHaveValue("0.25");
  await expect(page.locator("#caption-distance")).toHaveValue("1.8");
  await expect(page.locator("#launch-button")).toBeDisabled();
  await expect(page.locator("#xr-support")).toContainText("desktop preview");
});

test("retains the newest portal commentary response when older loads resolve last", async ({ page }) => {
  const pendingResponses = [];
  await page.unroute("**/api/**");
  await mockServer(page, {
    commentaryResponse: () => new Promise((resolve) => pendingResponses.push(resolve)),
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect.poll(() => pendingResponses.length).toBeGreaterThanOrEqual(2);

  pendingResponses.at(-1)({
    available: true,
    entries: [{ path: "newer.wav", name: "Newer", media_type: "audio/wav" }],
  });
  await expect(page.locator('.commentary-row[data-path="newer.wav"]')).toBeVisible();

  pendingResponses[0]({
    status: 503,
    json: { detail: "Older commentary response failed." },
  });
  await expect(page.locator('.commentary-row[data-path="newer.wav"]')).toBeVisible();
  await expect(page.locator('.commentary-row[data-path="older.wav"]')).toHaveCount(0);
  await expect(page.locator("#commentary-state")).toContainText("1 commentary audio file available");
  await expect(page.locator("#commentary-error")).toBeHidden();
  await expect(page.locator("#retry-commentary")).toBeHidden();
});

test("shows only top-level folders until disclosures expand and collapse their descendants", async ({
  page,
}) => {
  await page.goto("/");

  await expectVisibleDirectoryPaths(page, ["albums", "archive"]);
  await expect(directoryRow(page, "albums/trips")).not.toBeVisible();
  await expect(disclosureButton(page, "Expand", "albums")).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  await expandDirectory(page, "albums");
  await expectVisibleDirectoryPaths(page, [
    "albums",
    "albums/trips",
    "albums/favorites",
    "archive",
  ]);
  await expect(disclosureButton(page, "Expand", "trips")).toBeVisible();

  await expandDirectory(page, "trips");
  await expandDirectory(page, "2026");
  await expect(directoryRow(page, "albums/trips/2026/summer")).toBeVisible();

  await disclosureButton(page, "Collapse", "albums").click();
  await expectVisibleDirectoryPaths(page, ["albums", "archive"]);
  await expect(directoryRow(page, "albums/trips")).not.toBeVisible();
  await expect(directoryRow(page, "albums/trips/2026/summer")).not.toBeVisible();
});

test("derives parent selection state and persists collapsed directory selections", async ({
  page,
}) => {
  await page.goto("/");
  await expandDirectory(page, "albums");

  await directoryCheckbox(page, "albums/trips").check();
  await expect
    .poll(() => directoryCheckbox(page, "albums").evaluate((input) => input.indeterminate))
    .toBe(true);
  await expect(directoryCheckbox(page, "albums")).not.toBeChecked();

  await directoryCheckbox(page, "albums/favorites").check();
  await expect
    .poll(() => directoryCheckbox(page, "albums").evaluate((input) => input.indeterminate))
    .toBe(false);
  await expect(directoryCheckbox(page, "albums")).toBeChecked();

  await page.reload();
  await expectVisibleDirectoryPaths(page, ["albums", "archive"]);
  await expect(directoryRow(page, "albums/trips")).not.toBeVisible();

  await expandDirectory(page, "albums");
  await expect(directoryCheckbox(page, "albums")).toBeChecked();
  await expect(directoryCheckbox(page, "albums/trips")).toBeChecked();
  await expect(directoryCheckbox(page, "albums/favorites")).toBeChecked();
});
