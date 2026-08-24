import { expect, test } from "@playwright/test";
import {
  ALBUM_PATHS,
  DEFAULT_LIBRARY_ID,
  DIRECTORY_PATHS,
  clickSceneObject,
  createMaskPng,
  createTinyWebm,
  directoryCheckbox,
  directoryRow,
  disclosureButton,
  doubleTapSceneObject,
  dragSceneObject,
  expandAllDirectories,
  expandDirectory,
  expectVisibleDirectoryPaths,
  mockServer,
  paintAcrossPanelSurface,
  sceneObjectScreenPoint,
  selectBeachImage,
} from "./souvenir.fixtures.js";

test.beforeEach(async ({ page }) => {
  await mockServer(page);
});

test("uses matching media-backed tag pills across portal tag selectors", async ({ page }) => {
  const tagServer = {
    tags: [
      { id: "horse", name: "Horse" },
      { id: "blue", name: "Blue" },
      { id: "portrait", name: "Portrait" },
    ],
    assignments: new Map(),
    requests: [],
    nextId: 4,
  };
  const commentaryServer = {
    available: true,
    entries: [{
      path: "trips/2026/arrival.wav",
      name: "Arrival",
      media_type: "audio/wav",
      tag_ids: ["horse"],
    }],
    assignments: new Map(),
    requests: [],
    failuresRemaining: 0,
  };
  await page.unroute("**/api/**");
  await mockServer(page, { tagServer, commentaryServer });
  await page.goto("/");

  await directoryCheckbox(page, "albums").check();

  const backgroundFor = (locator) => locator.evaluate((element) =>
    element.style.getPropertyValue("--tag-pill-image"));

  const horseTag = page.locator("#tag-list .tag-pill", { hasText: "Horse" });
  const blueTag = page.locator("#tag-list .tag-pill", { hasText: "Blue" });
  await expect.poll(() => backgroundFor(horseTag)).toContain("albums%2F");
  await expect.poll(() => backgroundFor(blueTag)).toContain("albums%2F");
  await expect.poll(() => new Set([backgroundFor(horseTag), backgroundFor(blueTag)]).size).toBe(2);

  const arrival = page.locator('.commentary-row[data-path="trips/2026/arrival.wav"]');
  await arrival.getByLabel("Edit tags for Arrival").click();
  const arrivalHorse = arrival.locator(".commentary-tag-option .tag-pill", { hasText: "Horse" });
  await expect.poll(() => backgroundFor(arrivalHorse)).toContain("albums%2F");
  await expect.poll(() => new Set([
    backgroundFor(horseTag),
    backgroundFor(arrivalHorse),
  ]).size).toBeGreaterThan(1);

  await page.locator("#browse-button").click();
  await page.getByRole("button", { name: "albums", exact: true }).click();
  await page.locator('.browse-media[data-path="albums/beach.jpg"] .browse-media-select').click();
  const browseHorse = page.locator("#browse-tag-list .tag-pill", { hasText: "Horse" });
  await expect.poll(() => backgroundFor(browseHorse)).toContain("albums%2F");
  await expect.poll(() => new Set([
    backgroundFor(horseTag),
    backgroundFor(browseHorse),
  ]).size).toBeGreaterThan(1);
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

test("maximizes and restores each portal panel without losing state or scroll", async ({ page }) => {
  const commentaryServer = {
    available: true,
    entries: Array.from({ length: 18 }, (_, index) => ({
      path: `nested/commentary-${index + 1}.wav`,
      name: `Commentary ${index + 1}`,
      media_type: "audio/wav",
      tag_ids: index % 2 === 0 ? ["horse"] : [],
    })),
    assignments: new Map(),
    requests: [],
    failuresRemaining: 0,
  };
  const tagServer = {
    tags: [{ id: "horse", name: "Horse" }],
    assignments: new Map(),
    requests: [],
    nextId: 2,
  };
  await page.unroute("**/api/**");
  await mockServer(page, { commentaryServer, tagServer });
  await page.goto("/");

  await expect(page.locator("#tag-name")).toBeEnabled();
  await page.locator("#slideshow-speed").fill("12");
  await page.locator("#tag-name").fill("Draft tag");

  const panels = [
    { name: "Library", card: ".library-card" },
    { name: "Playback", card: ".playback-card" },
    { name: "Tags", card: ".tags-card" },
    { name: "Commentary", card: ".commentary-card" },
  ];
  const configuration = page.locator("#configuration");

  for (const panel of panels) {
    const card = page.locator(panel.card);
    const maximize = card.getByRole("button", { name: `Maximize ${panel.name} panel` });
    await maximize.click();
    await expect(configuration).toHaveClass(/has-maximized-panel/);
    await expect(card).toHaveClass(/is-maximized/);
    await expect(card.getByRole("button", { name: `Restore ${panel.name} panel` })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const otherPanel of panels.filter((candidate) => candidate.card !== panel.card)) {
      await expect(page.locator(otherPanel.card)).toBeHidden();
    }
    await card.getByRole("button", { name: `Restore ${panel.name} panel` }).click();
    await expect(configuration).not.toHaveClass(/has-maximized-panel/);
    await expect(card).not.toHaveClass(/is-maximized/);
    for (const otherPanel of panels.filter((candidate) => candidate.card !== panel.card)) {
      await expect(page.locator(otherPanel.card)).toBeVisible();
    }
  }

  await expect(page.locator("#slideshow-speed")).toHaveValue("12");
  await expect(page.locator("#tag-name")).toHaveValue("Draft tag");

  const commentaryCard = page.locator(".commentary-card");
  const maximizeCommentary = commentaryCard.getByRole("button", {
    name: "Maximize Commentary panel",
  });
  await maximizeCommentary.click();
  await commentaryCard.evaluate((element) => {
    element.scrollTop = 180;
  });
  await expect.poll(() => commentaryCard.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  await commentaryCard.getByRole("button", { name: "Restore Commentary panel" }).click();
  await maximizeCommentary.click();
  await expect.poll(() => commentaryCard.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
});

test("keeps the responsive portal viewport bounded and commentary rows compact", async ({ page }) => {
  const commentaryServer = {
    available: true,
    entries: [
      {
        path: "nested/compact.wav",
        name: "Compact sound",
        media_type: "audio/wav",
        tag_ids: ["horse", "blue"],
      },
    ],
    assignments: new Map(),
    requests: [],
    failuresRemaining: 0,
  };
  const tagServer = {
    tags: [{ id: "horse", name: "Horse" }, { id: "blue", name: "Blue" }],
    assignments: new Map(),
    requests: [],
    nextId: 3,
  };
  await page.unroute("**/api/**");
  await mockServer(page, { commentaryServer, tagServer });

  for (const viewport of [{ width: 1024, height: 640 }, { width: 390, height: 700 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    if (viewport.width <= 760) {
      await page.locator(".commentary-card .accordion-toggle").click();
    }
    const row = page.locator('.commentary-row[data-path="nested/compact.wav"]');
    await expect(row).toBeVisible();
    const bounds = await page.evaluate(() => ({
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      pageWidth: document.documentElement.scrollWidth,
      homeBottom: document.querySelector("#home")?.getBoundingClientRect().bottom,
      bodyOverflow: getComputedStyle(document.body).overflow,
      configurationOverflow: getComputedStyle(document.querySelector("#configuration")).overflowY,
      rowHeight: document.querySelector(".commentary-row")?.getBoundingClientRect().height,
    }));
    expect(bounds.pageWidth).toBeLessThanOrEqual(bounds.viewportWidth);
    expect(bounds.homeBottom).toBeLessThanOrEqual(bounds.viewportHeight);
    expect(bounds.bodyOverflow).toBe("hidden");
    expect(bounds.configurationOverflow).toBe("hidden");
    if (viewport.width > 760) expect(bounds.rowHeight).toBeLessThanOrEqual(76);

    await page.getByRole("button", { name: "Maximize Commentary panel" }).click();
    const maximizedBounds = await page.evaluate(() => {
      const card = document.querySelector(".commentary-card");
      const configuration = document.querySelector("#configuration");
      const home = document.querySelector("#home");
      return {
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        pageWidth: document.documentElement.scrollWidth,
        bodyOverflow: getComputedStyle(document.body).overflow,
        configurationOverflow: getComputedStyle(configuration).overflowY,
        cardRight: card?.getBoundingClientRect().right,
        cardBottom: card?.getBoundingClientRect().bottom,
        cardWidth: card?.getBoundingClientRect().width,
        configurationWidth: configuration?.getBoundingClientRect().width,
        homeBottom: home?.getBoundingClientRect().bottom,
      };
    });
    expect(maximizedBounds.pageWidth).toBeLessThanOrEqual(maximizedBounds.viewportWidth);
    expect(maximizedBounds.homeBottom).toBeLessThanOrEqual(maximizedBounds.viewportHeight);
    expect(maximizedBounds.bodyOverflow).toBe("hidden");
    expect(maximizedBounds.configurationOverflow).toBe("hidden");
    expect(maximizedBounds.cardRight).toBeLessThanOrEqual(maximizedBounds.viewportWidth);
    expect(maximizedBounds.cardBottom).toBeLessThanOrEqual(maximizedBounds.viewportHeight);
    expect(maximizedBounds.cardWidth).toBeLessThanOrEqual(maximizedBounds.configurationWidth + 1);
  }
});

test("restores maximized portal panels with Escape and returns focus", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#connection-status")).toHaveText("Local server");

  const maximize = page.locator(".playback-card").getByRole("button", {
    name: "Maximize Playback panel",
  });
  await maximize.click();
  await page.locator("#autoplay").focus();
  await expect(page.locator("#autoplay")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#configuration")).not.toHaveClass(/has-maximized-panel/);
  await expect(maximize).toBeFocused();
});

test("uses bounded mobile accordions for portal panels and keeps maximize compatible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("/");

  const library = page.locator(".library-card");
  const tags = page.locator(".tags-card");
  await expect(library).not.toHaveClass(/is-collapsed/);
  await expect(tags).toHaveClass(/is-collapsed/);
  await tags.locator(".accordion-toggle").click();
  await expect(tags).not.toHaveClass(/is-collapsed/);
  await expect(library).toHaveClass(/is-collapsed/);

  const maximizeTags = tags.getByRole("button", { name: "Maximize Tags panel" });
  await maximizeTags.click();
  await expect(tags).toHaveClass(/is-maximized/);
  await expect(library).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(tags).not.toHaveClass(/is-maximized/);
  await expect(tags).not.toHaveClass(/is-collapsed/);
  await expect(library).toHaveClass(/is-collapsed/);
  await expect(maximizeTags).toBeFocused();

  const bounds = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
    bottom: document.querySelector("#home").getBoundingClientRect().bottom,
    viewportHeight: innerHeight,
  }));
  expect(bounds.width).toBeLessThanOrEqual(bounds.viewportWidth);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
});

test("browses selected folders, previews images, and bulk toggles tags", async ({ page }) => {
  const video = await createTinyWebm(page);
  const tagServer = {
    tags: [{ id: "horse", name: "Horse" }, { id: "blue", name: "Blue" }],
    assignments: new Map(),
    requests: [],
    nextId: 3,
  };
  await page.unroute("**/api/**");
  await mockServer(page, {
    tagServer,
    extraEntries: {
      albums: [{
        name: "memory.webm",
        path: "albums/memory.webm",
        kind: "file",
        media_type: "video/webm",
        size: video.length,
        mtime: "2026-04-03T00:00:00Z",
      }],
    },
    videoFixtures: { "albums/memory.webm": video },
  });
  await page.goto("/");

  await directoryCheckbox(page, "albums").check();
  await page.locator("#browse-button").click();
  await expect(page.getByRole("heading", { name: "Souvenir library" })).toBeVisible();
  await page.getByRole("button", { name: "albums", exact: true }).click();
  const beach = page.locator('.browse-media[data-path="albums/beach.jpg"]');
  const forest = page.locator('.browse-media[data-path="albums/forest.jpg"]');
  const memory = page.locator('.browse-media[data-path="albums/memory.webm"]');
  await beach.locator(".browse-media-select").click();
  await forest.locator(".browse-media-select").click({ modifiers: ["Control"] });
  await memory.locator(".browse-media-select").click({ modifiers: ["Control"] });
  await expect(page.locator("#browse-selection-status")).toHaveText("3 selected");

  const blue = page.locator('#browse-tag-list input[value="blue"]');
  await expect.poll(() => blue.evaluate((input) => input.indeterminate)).toBe(true);
  await blue.check();
  await expect.poll(() =>
    tagServer.requests.filter((request) => request.method === "PUT_BULK").length).toBe(3);
  await expect(blue).toBeChecked();
  await expect(forest.locator(".browse-tag-count-badge")).toHaveText("2");
  await expect(memory.locator(".browse-tag-count-badge")).toHaveText("1");
  await blue.uncheck();
  await expect.poll(() =>
    tagServer.requests.filter((request) => request.method === "PUT_BULK").length).toBe(6);
  await expect(beach.locator(".browse-tag-count-badge")).toHaveText("1");
  await expect(memory.locator(".browse-tag-count-badge")).toHaveText("0");

  const beachPreview = beach.getByRole("button", { name: "Preview" });
  await beachPreview.click();
  await expect(page.locator("#browse-viewer")).toBeVisible();
  await expect(page.locator(".browse-workspace")).toHaveJSProperty("inert", true);
  await expect(page.locator("#browse-viewer-title")).toHaveText("beach.jpg");
  await page.locator("#browse-zoom-in").click();
  await expect(page.locator("#browse-zoom-value")).toHaveText("125%");
  await page.locator("#browse-fit").click();
  await expect(page.locator("#browse-zoom-value")).toHaveText("100%");
  await page.keyboard.press("Escape");
  await expect(page.locator("#browse-viewer")).toBeHidden();
  await expect(beachPreview).toBeFocused();
  await memory.getByRole("button", { name: "Preview" }).click();
  await expect(page.locator("#browse-viewer-video")).toBeVisible();
  await expect(page.locator("#browse-image-controls")).toBeHidden();
  await page.keyboard.press("Escape");
  await page.locator("#exit-browse").click();
  await expect(page.locator("#home")).toBeVisible();
});

test("fits fifty Browse tags in a desktop window without scrolling", async ({ page }) => {
  const tagServer = {
    tags: Array.from({ length: 50 }, (_, index) => ({
      id: `tag-${index + 1}`,
      name: `Tag ${String(index + 1).padStart(2, "0")}`,
    })),
    assignments: new Map(),
    requests: [],
    nextId: 51,
  };
  await page.unroute("**/api/**");
  await mockServer(page, { tagServer });
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.goto("/");

  await page.locator("#browse-button").click();
  await page.getByRole("button", { name: "albums", exact: true }).click();
  await page.locator('.browse-media[data-path="albums/beach.jpg"] .browse-media-select').click();
  await expect(page.locator("#browse-tag-list label")).toHaveCount(50);

  const bounds = await page.locator(".browse-tags").evaluate((panel) => ({
    clientHeight: panel.clientHeight,
    scrollHeight: panel.scrollHeight,
    clientWidth: panel.clientWidth,
    scrollWidth: panel.scrollWidth,
  }));
  expect(bounds.scrollHeight).toBeLessThanOrEqual(bounds.clientHeight);
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
});

test("shows thumbnail tag counts and filters Browse media by count ranges", async ({ page }) => {
  const tagIds = Array.from({ length: 11 }, (_, index) => `tag-${index + 1}`);
  await page.unroute("**/api/**");
  await mockServer(page, {
    extraEntries: {
      albums: [
        {
          name: "five-tags.jpg",
          path: "albums/five-tags.jpg",
          kind: "file",
          media_type: "image/jpeg",
          tag_ids: tagIds.slice(0, 5),
        },
        {
          name: "ten-tags.jpg",
          path: "albums/ten-tags.jpg",
          kind: "file",
          media_type: "image/jpeg",
          tag_ids: tagIds.slice(0, 10),
        },
        {
          name: "eleven-tags.jpg",
          path: "albums/eleven-tags.jpg",
          kind: "file",
          media_type: "image/jpeg",
          tag_ids: tagIds,
        },
      ],
    },
  });
  await page.goto("/");
  await page.locator("#browse-button").click();
  await page.getByRole("button", { name: "albums", exact: true }).click();

  const media = (name) => page.locator(`.browse-media[data-path="albums/${name}"]`);
  await expect(media("beach.jpg").locator(".browse-tag-count-badge")).toHaveText("2");
  await expect(media("photo-1.jpg").locator(".browse-tag-count-badge")).toHaveText("0");
  await expect(media("eleven-tags.jpg").locator(".browse-tag-count-badge")).toHaveText("11");

  const filter = page.locator("#browse-tag-count-filter");
  await filter.selectOption("0");
  await expect(media("photo-1.jpg")).toBeVisible();
  await expect(media("forest.jpg")).toHaveCount(0);

  await filter.selectOption("1-2");
  await expect(media("beach.jpg")).toBeVisible();
  await expect(media("forest.jpg")).toBeVisible();
  await expect(media("five-tags.jpg")).toHaveCount(0);

  await filter.selectOption("3-10");
  await expect(media("five-tags.jpg")).toBeVisible();
  await expect(media("ten-tags.jpg")).toBeVisible();
  await expect(media("eleven-tags.jpg")).toHaveCount(0);

  await filter.selectOption("10+");
  await expect(media("ten-tags.jpg")).toBeVisible();
  await expect(media("eleven-tags.jpg")).toBeVisible();
  await expect(media("five-tags.jpg")).toHaveCount(0);
});

test("creates, rejects duplicates, renames, deletes, and reloads shared tags", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("tag-portal-storage-cleared")) {
      localStorage.clear();
      sessionStorage.setItem("tag-portal-storage-cleared", "true");
    }
  });
  await page.goto("/");
  await expect(page.locator("#tag-state")).toContainText("No shared tags");

  for (const name of ["Horse", "Blue", "Portrait"]) {
    await page.locator("#tag-name").fill(name);
    await page.locator("#add-tag").click();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }

  await page.locator("#tag-name").fill("horse");
  await page.locator("#add-tag").click();
  await expect(page.locator("#tag-error")).toContainText("already exists");
  await page.locator("#retry-tags").click();
  await expect(page.locator("#tag-error")).toBeHidden();

  await page.getByRole("button", { name: "Rename Horse", exact: true }).click();
  await page.locator("#tag-rename-input").fill("Pony");
  await page.getByRole("button", { name: "Save renamed tag Horse", exact: true }).click();
  await expect(page.getByText("Pony", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Delete Portrait", exact: true }).click();
  await expect(page.getByText("Portrait", { exact: true })).toBeHidden();
  await page.reload();
  await expect(page.getByText("Pony", { exact: true })).toBeVisible();
  await expect(page.getByText("Blue", { exact: true })).toBeVisible();
  await expect(page.getByText("Portrait", { exact: true })).toBeHidden();
});

test("shows unavailable and empty commentary states without hiding gallery controls", async ({ page }) => {
  const commentaryServer = {
    available: false,
    entries: [],
    assignments: new Map(),
    requests: [],
    failuresRemaining: 0,
  };
  await page.unroute("**/api/**");
  await mockServer(page, { commentaryServer });
  await page.goto("/");
  await expect(page.locator("#commentary-state")).toContainText("not configured");
  await expect(page.locator("#commentary-list .commentary-row")).toHaveCount(0);
  await expect(page.locator("#preview-button")).toBeEnabled();

  commentaryServer.available = true;
  await page.reload();
  await expect(page.locator("#commentary-state")).toContainText("No commentary audio files");
  await expect(page.locator("#preview-button")).toBeEnabled();
});

test("plays, switches, finishes, errors, and saves nested commentary tag assignments", async ({ page }) => {
  const tagServer = {
    tags: [{ id: "horse", name: "Horse" }, { id: "blue", name: "Blue" }],
    assignments: new Map(),
    requests: [],
    nextId: 3,
  };
  const commentaryServer = {
    available: true,
    entries: [
      { path: "trips/2026/arrival.wav", name: "Arrival", media_type: "audio/wav" },
      { path: "trips/2026/departure.wav", name: "Departure", media_type: "audio/wav" },
    ],
    assignments: new Map(),
    requests: [],
    failuresRemaining: 0,
  };
  await page.addInitScript(() => {
    window.__commentaryAudioEvents = [];
    window.__commentaryAudioElements = [];
    const originalPlay = HTMLMediaElement.prototype.play;
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value() {
        window.__commentaryAudioElements.push(this);
        window.__commentaryAudioEvents.push({ type: "play", src: this.src });
        return Promise.resolve();
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value() {
        window.__commentaryAudioEvents.push({ type: "pause", src: this.src });
      },
    });
    window.__restoreAudioPlay = originalPlay;
  });
  await page.unroute("**/api/**");
  await mockServer(page, { tagServer, commentaryServer });
  await page.goto("/");

  const arrival = page.locator('.commentary-row[data-path="trips/2026/arrival.wav"]');
  const departure = page.locator('.commentary-row[data-path="trips/2026/departure.wav"]');
  await expect(arrival).toBeVisible();
  await expect(departure).toBeVisible();
  await expect(arrival.locator(".commentary-path")).toHaveText("trips/2026/arrival.wav");
  await arrival.getByRole("slider", { name: "Volume for Arrival" }).fill("1.4");
  await expect(arrival.locator(".commentary-volume output")).toHaveText("140%");
  await expect.poll(() => commentaryServer.volumes.get("trips/2026/arrival.wav")).toBe(1.4);

  await arrival.getByRole("button", { name: "Play Arrival" }).click();
  await expect(arrival.locator(".commentary-playback-status")).toHaveText("Playing");
  await expect.poll(() => page.evaluate(() => window.__commentaryAudioEvents.filter(
    (event) => event.type === "play",
  ))).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => window.__commentaryAudioElements.at(-1).volume))
    .toBe(1);
  await expect.poll(() => page.evaluate(() => window.__commentaryAudioEvents.at(-1).src))
    .toContain("/api/commentary/file?path=trips%2F2026%2Farrival.wav");

  await arrival.getByRole("button", { name: "Stop Arrival" }).click();
  await expect(arrival.locator(".commentary-playback-status")).toHaveText("Stopped");
  await departure.getByRole("button", { name: "Play Departure" }).click();
  await expect(departure.locator(".commentary-playback-status")).toHaveText("Playing");
  await page.evaluate(() => window.__commentaryAudioElements.at(-1).dispatchEvent(new Event("ended")));
  await expect(departure.locator(".commentary-playback-status")).toHaveText("Finished");
  await expect.poll(() => page.evaluate(() => window.__commentaryAudioEvents.filter(
    (event) => event.type === "pause",
  ).length)).toBeGreaterThanOrEqual(2);

  await arrival.getByRole("button", { name: "Play Arrival" }).click();
  await page.evaluate(() => window.__commentaryAudioElements.at(-1).dispatchEvent(new Event("error")));
  await expect(arrival.locator(".commentary-playback-status"))
    .toHaveText("Playback could not be started.");

  await arrival.getByLabel("Edit tags for Arrival").click();
  await arrival.getByRole("checkbox", { name: "Assign Blue to Arrival" }).evaluate((blue) => {
    const options = blue.closest("fieldset");
    const horse = options?.querySelector('input[aria-label="Assign Horse to Arrival"]');
    blue.checked = true;
    horse.checked = true;
    blue.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(() => commentaryServer.requests.at(-1)).toMatchObject({
    method: "PUT",
    path: "trips/2026/arrival.wav",
    tagIds: ["blue", "horse"],
  });
  await expect(arrival.locator(".commentary-inline-tag")).toHaveText(["Blue", "Horse"]);

  await arrival.getByLabel("Add captions for Arrival").click();
  await arrival.getByRole("textbox", { name: "Captions for Arrival" })
    .fill("Arriving now##Look to your left");
  await arrival.getByRole("button", { name: "Save captions for Arrival" }).click();
  await expect.poll(() => commentaryServer.captions.get("trips/2026/arrival.wav"))
    .toBe("Arriving now##Look to your left");
  await expect.poll(() => commentaryServer.requests.at(-1)).toMatchObject({
    method: "PUT",
    path: "trips/2026/arrival.wav",
    caption: "Arriving now##Look to your left",
  });
  await expect(arrival.getByLabel("Edit captions for Arrival")).toBeVisible();

  await page.getByRole("button", { name: "Delete Blue", exact: true }).click();
  await expect.poll(() => commentaryServer.assignments.get("trips/2026/arrival.wav"))
    .toEqual(["horse"]);
  await arrival.getByLabel("Edit tags for Arrival").click();
  await expect(arrival.getByRole("checkbox", { name: "Assign Blue to Arrival" })).toHaveCount(0);
  await expect(arrival.getByRole("checkbox", { name: "Assign Horse to Arrival" })).toBeChecked();
});

test("filters portal commentary by multiple tags or untagged-only", async ({ page }) => {
  const tagServer = {
    tags: [{ id: "horse", name: "Horse" }, { id: "blue", name: "Blue" }],
    assignments: new Map(),
    requests: [],
    nextId: 3,
  };
  const commentaryServer = {
    available: true,
    entries: [
      { path: "horse.wav", name: "Horse note", media_type: "audio/wav" },
      { path: "blue-horse.wav", name: "Blue horse note", media_type: "audio/wav" },
      { path: "untagged.wav", name: "Untagged note", media_type: "audio/wav" },
    ],
    assignments: new Map([
      ["horse.wav", ["horse"]],
      ["blue-horse.wav", ["horse", "blue"]],
    ]),
    requests: [],
    failuresRemaining: 0,
  };
  await page.unroute("**/api/**");
  await mockServer(page, { tagServer, commentaryServer });
  await page.goto("/");

  const rows = page.locator("#commentary-list .commentary-row");
  await expect(rows).toHaveCount(3);
  await expect(page.getByRole("button", { name: "All", exact: true }))
    .toHaveAttribute("aria-pressed", "true");

  await page.getByRole("checkbox", { name: "Filter commentary by Horse" }).check();
  await expect(rows).toHaveCount(2);
  await expect(page.locator('.commentary-row[data-path="untagged.wav"]')).toHaveCount(0);

  await page.getByRole("checkbox", { name: "Filter commentary by Blue" }).check();
  await expect(rows).toHaveCount(1);
  await expect(page.locator('.commentary-row[data-path="blue-horse.wav"]')).toBeVisible();
  await expect(page.locator("#commentary-state")).toContainText("1 of 3");

  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(rows).toHaveCount(3);
  await page.getByRole("button", { name: "Untagged only", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.locator('.commentary-row[data-path="untagged.wav"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Untagged only", exact: true }))
    .toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Untagged only", exact: true }).click();
  await expect(rows).toHaveCount(3);
  await page.getByRole("checkbox", { name: "Filter commentary by Horse" }).check();
  await page.getByRole("button", { name: "Delete Horse", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Filter commentary by Horse" }))
    .toHaveCount(0);
  await expect(page.getByRole("button", { name: "All", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(3);
});

test("retries commentary failures without disabling preview", async ({ page }) => {
  const commentaryServer = {
    available: true,
    entries: [{ path: "retry.wav", name: "Retry", media_type: "audio/wav" }],
    assignments: new Map(),
    requests: [],
    failuresRemaining: 5,
  };
  await page.unroute("**/api/**");
  await mockServer(page, { commentaryServer });
  await page.goto("/");
  await expect(page.locator("#commentary-error")).toContainText("temporarily unavailable");
  await expect(page.locator("#retry-commentary")).toBeVisible();
  await expect(page.locator("#preview-button")).toBeEnabled();
  commentaryServer.failuresRemaining = 0;
  await page.locator("#retry-commentary").click();
  await expect(page.locator('.commentary-row[data-path="retry.wav"]')).toBeVisible();
  await expect(page.locator("#commentary-error")).toBeHidden();
  await expect(page.locator("#preview-button")).toBeEnabled();
});

test("keeps portal commentary playing through a shared-tag refresh for the same file", async ({ page }) => {
  const tagServer = {
    tags: [],
    assignments: new Map(),
    requests: [],
    nextId: 1,
  };
  const commentaryServer = {
    available: true,
    entries: [{ path: "notes/kept.wav", name: "Kept", media_type: "audio/wav" }],
    assignments: new Map(),
    requests: [],
    failuresRemaining: 0,
  };
  await page.addInitScript(() => {
    window.__portalAudioEvents = [];
    window.__portalAudioElements = [];
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value() {
        window.__portalAudioElements.push(this);
        window.__portalAudioEvents.push({ type: "play", src: this.src });
        return Promise.resolve();
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value() {
        window.__portalAudioEvents.push({ type: "pause", src: this.src });
      },
    });
  });
  await page.unroute("**/api/**");
  await mockServer(page, { tagServer, commentaryServer });
  await page.goto("/");

  const row = page.locator('.commentary-row[data-path="notes/kept.wav"]');
  await row.getByRole("button", { name: "Play Kept" }).click();
  await expect(row.locator(".commentary-playback-status")).toHaveText("Playing");
  const sourceBeforeRefresh = await page.evaluate(() => window.__portalAudioElements.at(-1).src);
  const pausesBeforeRefresh = await page.evaluate(() => window.__portalAudioEvents.filter(
    (event) => event.type === "pause",
  ).length);

  await page.locator("#tag-name").fill("Fresh");
  await page.locator("#add-tag").click();
  await expect(page.locator("#tag-list .tag-name")).toHaveText("Fresh");
  await expect(row.locator(".commentary-playback-status")).toHaveText("Playing");
  await expect(row.getByRole("button", { name: "Stop Kept" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    source: window.__portalAudioElements.at(-1).src,
    pauses: window.__portalAudioEvents.filter((event) => event.type === "pause").length,
  }))).toEqual({ source: sourceBeforeRefresh, pauses: pausesBeforeRefresh });
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

test("selecting and deselecting a parent recursively changes every descendant", async ({
  page,
}) => {
  await page.goto("/");
  await expandAllDirectories(page);

  await directoryCheckbox(page, "albums").check();
  for (const path of ALBUM_PATHS) {
    await expect(directoryCheckbox(page, path)).toBeChecked();
  }

  await directoryCheckbox(page, "albums").uncheck();
  for (const path of ALBUM_PATHS) {
    await expect(directoryCheckbox(page, path)).not.toBeChecked();
  }
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

test("surfaces a media-server failure", async ({ page }) => {
  await page.unroute("**/api/**");
  await mockServer(page, {
    libraryStatuses: [
      {
        status: "error",
        scanned_files: 8,
        media_files: 6,
        directories: 1,
        current_path: "albums/broken.jpg",
        message: "Library is unavailable",
        started_at: "2026-03-01T00:00:00Z",
        completed_at: "2026-03-01T00:00:01Z",
      },
    ],
  });
  await page.goto("/");
  await expect(page.locator("#connection-status")).toHaveText("Server unavailable");
  await expect(page.locator("#app-error")).toContainText("Library is unavailable");
  await expect(page.locator("#library-progress-status")).toHaveText(
    "Library scanning needs attention",
  );
  await expect(page.locator("#preview-button")).toBeDisabled();
  await expect(page.locator("#launch-button")).toBeDisabled();
});

test("shows scanning progress and unlocks the portal when the library is ready", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "xr", {
      configurable: true,
      value: { isSessionSupported: async () => true },
    });
  });
  await page.unroute("**/api/**");
  await mockServer(page, {
    libraryStatuses: [
      {
        status: "scanning",
        scanned_files: 3,
        media_files: 2,
        directories: 1,
        current_path: "albums/beach.jpg",
        message: "",
        started_at: "2026-03-01T00:00:00Z",
        completed_at: null,
      },
      {
        status: "scanning",
        scanned_files: 7,
        media_files: 5,
        directories: 2,
        current_path: "albums/forest.jpg",
        message: "",
        started_at: "2026-03-01T00:00:00Z",
        completed_at: null,
      },
      {
        status: "ready",
        scanned_files: 12,
        media_files: 11,
        directories: 2,
        current_path: "",
        message: "",
        started_at: "2026-03-01T00:00:00Z",
        completed_at: "2026-03-01T00:00:02Z",
      },
    ],
  });

  await page.goto("/");

  await expect(page.locator("#library-progress")).toBeVisible();
  await expect(page.locator("#library-progress-status")).toHaveText(
    "Scanning your media library",
  );
  await expect(page.locator("#library-progress-counts")).toHaveText(
    "3 files scanned · 2 media files · 1 folders",
  );
  await expect(page.locator("#library-progress-path")).toHaveText(
    "Currently scanning: albums/beach.jpg",
  );
  await expect(page.locator("#library-progress-bar")).toHaveAttribute(
    "aria-valuetext",
    "Scanning: 3 files scanned, 2 media files, 1 folders.",
  );
  await expect(page.locator("#preview-button")).toBeDisabled();
  await expect(page.locator("#launch-button")).toBeDisabled();

  await expect(page.locator("#library-progress-counts")).toHaveText(
    "7 files scanned · 5 media files · 2 folders",
  );
  await expect(page.locator("#library-progress-path")).toHaveText(
    "Currently scanning: albums/forest.jpg",
  );
  await expect(page.locator('.directory-row input[value="albums"]')).toBeVisible();
  await expect(page.locator("#library-progress")).toBeHidden();
  await expect(page.locator("#preview-button")).toBeEnabled();
  await expect(page.locator("#launch-button")).toBeEnabled();
});


test("controls panels, browser, navigation, transforms, slideshow and restore", async ({
  page,
}) => {
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();
  await page.waitForTimeout(150);
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp?.store.getState().panels.length),
  ).toBe(1);

  await clickSceneObject(page, { action: "add-panel" });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels.length),
  ).toBe(2);
  await clickSceneObject(page, { action: "remove-panel" });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels.length),
  ).toBe(1);

  const panelId = await page.evaluate(
    () => window.__souvenirApp.store.getState().focusedId,
  );
  await clickSceneObject(page, { action: "browse", panelId });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.browser?.visible),
  ).toBe(true);

  await clickSceneObject(page, { action: "browser-view" });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.browser.viewMode),
  ).toBe("thumbnails");
  await clickSceneObject(page, { action: "browser-view" });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.browser.viewMode),
  ).toBe("large");
  await clickSceneObject(page, { action: "browser-page-next" });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.browser.page),
  ).toBe(1);

  for (const expected of ["mtime", "size", "random", "name"]) {
    await clickSceneObject(page, { action: "browser-sort" });
    await expect.poll(() =>
      page.evaluate(() => window.__souvenirApp.browser.sortMode),
    ).toBe(expected);
  }

  await clickSceneObject(page, {
    kind: "browser-entry",
    entryPath: "albums/beach.jpg",
  });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].media.selectedId),
  ).toBe("albums/beach.jpg");

  await clickSceneObject(
    page,
    { kind: "panel-surface", panelId },
    { x: 0.4, y: 0, z: 0 },
  );
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].media.selectedId),
  ).toBe("albums/forest.jpg");

  await clickSceneObject(page, { action: "toggle-lock", panelId });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].locked),
  ).toBe(true);
  const center = await page.evaluate((id) => {
    const app = window.__souvenirApp;
    const surface = app.panelViews.get(id).surface;
    const vector = surface.position.clone();
    surface.getWorldPosition(vector);
    vector.project(app.camera);
    const rect = app.canvas.getBoundingClientRect();
    return {
      x: rect.left + ((vector.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - vector.y) / 2) * rect.height,
    };
  }, panelId);
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, -180);
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].content.zoom),
  ).toBeGreaterThan(1);

  await clickSceneObject(page, { action: "toggle-lock", panelId });
  await clickSceneObject(page, { action: "toggle-minimize", panelId });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].minimized),
  ).toBe(true);
  await clickSceneObject(page, { kind: "panel-surface", panelId });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].minimized),
  ).toBe(false);

  await clickSceneObject(page, { action: "toggle-slideshow", panelId });
  await expect.poll(() =>
    page.evaluate((id) => window.__souvenirApp.runtime.get(id).slideshow.active, panelId),
  ).toBe(true);
  await page.locator("#exit-preview").click();
  await page.reload();
  await expect(page.locator("#connection-status")).toHaveText("Local server");
  await page.locator("#preview-button").click();
  await expect.poll(() => page.evaluate(() => Boolean(window.__souvenirApp?.store))).toBe(true);
  const restart = await page.evaluate(() => ({
    ready: Boolean(window.__souvenirApp?.store),
    error: document.querySelector("#app-error").hidden
      ? ""
      : document.querySelector("#app-error").textContent,
  }));
  expect(restart.error).toBe("");
  expect(restart.ready).toBe(true);
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].media.selectedId),
  ).toBe("albums/forest.jpg");
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].content.zoom),
  ).toBeGreaterThan(1);
});
