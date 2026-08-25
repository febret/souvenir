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

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await mockServer(page);
});

test("selects weighted commentary from live panel tags and cleans up AR playback", async ({ page }) => {
  const commentaryServer = {
    available: true,
    entries: [
      { path: "first.wav", name: "First", tag_ids: ["horse"] },
      {
        path: "second.wav",
        name: "Second",
        tag_ids: ["blue"],
        caption: "Blue scene##Look again",
        volume: 0.35,
      },
      { path: "third.wav", name: "Third", tag_ids: ["green"] },
      { path: "fourth.wav", name: "Fourth", tag_ids: ["red"] },
    ],
    assignments: new Map(),
    requests: [],
    failuresRemaining: 0,
  };
  await page.addInitScript(() => {
    window.__spatialAudioEvents = [];
    window.__spatialAudioElements = [];
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value() {
        window.__spatialAudioElements.push(this);
        window.__spatialAudioEvents.push({ type: "play", src: this.src });
        return Promise.resolve();
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value() {
        window.__spatialAudioEvents.push({ type: "pause", src: this.src });
      },
    });
  });
  await page.unroute("**/api/**");
  await mockServer(page, { commentaryServer });
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#caption-size").fill("1.4");
  await page.locator("#caption-transparency").fill("0.25");
  await page.locator("#caption-distance").fill("1.8");
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();

  await page.evaluate(() => {
    const app = window.__souvenirApp;
    const first = app.store.getState().focusedId;
    const setPanel = (id, path, tags) => {
      app.store.setMedia(id, path);
      app.mediaTagLookup.set(path, tags);
    };
    setPanel(first, "panel-horse-1.jpg", ["horse"]);
    for (const [path, tags] of [
      ["panel-horse-2.jpg", ["horse"]],
      ["panel-horse-3.jpg", ["horse"]],
      ["panel-blue-1.jpg", ["blue"]],
      ["panel-blue-2.jpg", ["blue"]],
      ["panel-green.jpg", ["green"]],
      ["panel-red.jpg", ["red"]],
    ]) {
      const panel = app.store.add();
      setPanel(panel.id, path, tags);
    }
    Math.random = () => 0.6;
  });
  await expect.poll(() => page.evaluate(() => {
    const button = window.__souvenirApp.toolbar.commentaryButton.userData;
    return { available: button.available, interactive: button.interactive, disabled: button.disabled };
  })).toEqual({ available: true, interactive: true, disabled: false });

  const panelsBeforeAdd = await page.evaluate(() => window.__souvenirApp.store.getState().panels.length);
  await clickSceneObject(page, { action: "add-panel" });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.store.getState().panels.length))
    .toBe(panelsBeforeAdd + 1);
  await page.evaluate(() => {
    const app = window.__souvenirApp;
    app.setEnvironmentMode("night");
    const panel = app.store.getState().panels[0];
    app.applyGesture(panel.id, {
      hands: 1,
      absolutePose: { position: { x: 0.2, y: 1.2, z: -1.5 } },
    });
  });
  await expect.poll(() => page.evaluate(() => ({
    mode: window.__souvenirApp.currentEnvironmentMode,
    x: window.__souvenirApp.store.getState().panels[0].transform.position.x,
  }))).toEqual({ mode: "night", x: 0.2 });

  await clickSceneObject(page, { action: "toggle-commentary" });
  await expect.poll(() => page.evaluate(() => ({
    enabled: window.__souvenirApp.commentaryEnabled,
    playing: window.__souvenirApp.commentaryPlaying,
    path: window.__souvenirApp.commentaryPath,
    scores: window.__souvenirApp.commentaryScores.map(({ path, score }) => ({ path, score })),
    plays: window.__spatialAudioEvents.filter((event) => event.type === "play").length,
  }))).toEqual({
    enabled: true,
    playing: true,
    path: "second.wav",
    scores: [
      { path: "first.wav", score: 3 },
      { path: "second.wav", score: 2 },
      { path: "fourth.wav", score: 1 },
      { path: "third.wav", score: 1 },
    ],
    plays: 1,
  });
  await page.evaluate(() => {
    Object.defineProperty(window.__souvenirApp.commentaryAudio, "currentTime", {
      configurable: true,
      writable: true,
      value: 0.5,
    });
  });
  await expect.poll(() => page.evaluate(() => {
    const app = window.__souvenirApp;
    return {
      text: app.captionView.currentText,
      visible: app.captionView.visible,
      scale: app.captionView.scale.x,
      opacity: app.captionView.material.opacity,
      distance: app.captionView.position.distanceTo(app.camera.position),
      volume: app.commentaryAudio.volume,
    };
  })).toEqual({
    text: "Blue scene",
    visible: true,
    scale: 1.4,
    opacity: 0.75,
    distance: expect.closeTo(1.8, 2),
    volume: 0.35,
  });
  await page.evaluate(() => {
    window.__souvenirApp.commentaryAudio.currentTime = 1.5;
  });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.captionView.visible))
    .toBe(false);
  await page.evaluate(() => {
    window.__souvenirApp.commentaryAudio.currentTime = 3.2;
  });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.captionView.currentText))
    .toBe("Look again");

  await page.evaluate(() => {
    const app = window.__souvenirApp;
    for (const panel of app.store.getState().panels) {
      if (panel.media.selectedId?.startsWith("panel-")
        && panel.media.selectedId !== "panel-red.jpg") {
        app.mediaTagLookup.set(panel.media.selectedId, ["blue"]);
      }
    }
    Math.random = () => 0;
    app.commentaryAudio.dispatchEvent(new Event("ended"));
  });
  await expect.poll(() => page.evaluate(() => ({
    path: window.__souvenirApp.commentaryPath,
    playing: window.__souvenirApp.commentaryPlaying,
    audioInstances: new Set(window.__spatialAudioElements).size,
    plays: window.__spatialAudioEvents.filter((event) => event.type === "play").length,
  }))).toEqual({ path: "fourth.wav", playing: true, audioInstances: 1, plays: 2 });

  await clickSceneObject(page, { action: "toggle-commentary" });
  const stopped = await page.evaluate(() => ({
    enabled: window.__souvenirApp.commentaryEnabled,
    playing: window.__souvenirApp.commentaryPlaying,
    source: window.__souvenirApp.commentaryAudio?.getAttribute("src"),
    pauses: window.__spatialAudioEvents.filter((event) => event.type === "pause").length,
  }));
  expect(stopped).toMatchObject({ enabled: false, playing: false, source: null });
  expect(stopped.pauses).toBeGreaterThanOrEqual(1);
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.captionView.visible))
    .toBe(false);
});

test("keeps a confirmed media tag when a second rapid menu activation arrives during a save", async ({
  page,
}) => {
  let releaseFirstSave;
  const firstSave = new Promise((resolve) => { releaseFirstSave = resolve; });
  let holdFirstSave = true;
  const tagServer = {
    tags: [{ id: "horse", name: "Horse" }, { id: "blue", name: "Blue" }],
    assignments: new Map([["albums/beach.jpg", []]]),
    requests: [],
    nextId: 1,
  };
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("tag-pending-storage-cleared")) {
      localStorage.clear();
      sessionStorage.setItem("tag-pending-storage-cleared", "true");
    }
  });
  await page.unroute("**/api/**");
  await mockServer(page, {
    tagServer,
    beforeSaveMediaTags: async () => {
      if (!holdFirstSave) return;
      holdFirstSave = false;
      await firstSave;
    },
  });
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();
  await expect.poll(() => page.evaluate(() => Boolean(window.__souvenirApp?.store))).toBe(true);
  const panelId = await page.evaluate(() => window.__souvenirApp.store.getState().focusedId);
  await selectBeachImage(page, panelId);
  await clickSceneObject(page, { action: "toggle-options", panelId });
  await expect.poll(() => page.evaluate((id) =>
    window.__souvenirApp.panelViews.get(id)?.optionsPanel?.visible, panelId)).toBe(true);

  const pending = await page.evaluate((id) => {
    const app = window.__souvenirApp;
    app.panelCoordinator.handleAction(id, "toggle-media-tag:horse");
    app.panelCoordinator.handleAction(id, "toggle-media-tag:blue");
    return {
      pending: app.panelCoordinator.isTagSavePending(id),
      mediaTagIds: app.panelViews.get(id).mediaTagIds,
    };
  }, panelId);
  expect(pending).toEqual({ pending: true, mediaTagIds: [] });
  await expect.poll(() => tagServer.requests.filter((request) => request.method === "PUT"))
    .toHaveLength(1);
  expect(tagServer.requests.at(-1)).toMatchObject({ path: "albums/beach.jpg", tagIds: ["horse"] });

  releaseFirstSave();
  await expect.poll(() => page.evaluate((id) => {
    const app = window.__souvenirApp;
    return {
      pending: app.panelCoordinator.isTagSavePending(id),
      mediaTagIds: app.panelViews.get(id).mediaTagIds,
    };
  }, panelId)).toEqual({ pending: false, mediaTagIds: ["horse"] });
  await expect.poll(() => tagServer.assignments.get("albums/beach.jpg")).toEqual(["horse"]);
  expect(tagServer.requests.filter((request) => request.method === "PUT")).toHaveLength(1);

  const secondPanelId = await page.evaluate(() => {
    const app = window.__souvenirApp;
    const panel = app.store.add();
    app.store.setDirectory(panel.id, "albums");
    app.store.setMedia(panel.id, "albums/beach.jpg");
    return panel.id;
  });
  await expect.poll(() => page.evaluate((id) =>
    window.__souvenirApp.panelViews.get(id)?.mediaTagIds, secondPanelId,
  )).toEqual(["horse"]);
});

test("keeps the newest AND-filtered playlist when delayed directory responses resolve out of order", async ({
  page,
}) => {
  const directoryReleases = [];
  let deferDirectoryResponses = false;
  const tagServer = {
    tags: [{ id: "horse", name: "Horse" }, { id: "blue", name: "Blue" }],
    assignments: new Map([
      ["albums/beach.jpg", ["horse", "blue"]],
      ["albums/forest.jpg", ["horse"]],
    ]),
    requests: [],
    nextId: 1,
  };
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("tag-directory-race-storage-cleared")) {
      localStorage.clear();
      sessionStorage.setItem("tag-directory-race-storage-cleared", "true");
    }
  });
  await page.unroute("**/api/**");
  await mockServer(page, {
    tagServer,
    directoryResponse: ({ path, entries }) => {
      if (!deferDirectoryResponses || path !== "albums") return entries;
      return new Promise((resolve) => directoryReleases.push(() => resolve(entries)));
    },
  });
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();
  const panelId = await page.evaluate(() => window.__souvenirApp.store.getState().focusedId);
  await selectBeachImage(page, panelId);

  deferDirectoryResponses = true;
  await page.evaluate(() => {
    const browser = window.__souvenirApp.browser;
    browser.onTagFilterChange(["horse"]);
    browser.onTagFilterChange(["horse", "blue"]);
  });
  await expect.poll(() => directoryReleases.length).toBe(2);

  directoryReleases[1]();
  await expect.poll(() => page.evaluate((id) => {
    const app = window.__souvenirApp;
    return {
      filter: app.store.getState().panels.find((panel) => panel.id === id)?.tagFilter,
      playlist: app.runtime.get(id)?.playlist.map((entry) => entry.path),
    };
  }, panelId)).toEqual({
    filter: ["horse", "blue"],
    playlist: ["albums/beach.jpg"],
  });

  directoryReleases[0]();
  await expect.poll(() => page.evaluate((id) => {
    const app = window.__souvenirApp;
    return app.runtime.get(id)?.playlist.map((entry) => entry.path);
  }, panelId)).toEqual(["albums/beach.jpg"]);
  await clickSceneObject(page, { kind: "panel-surface", panelId }, { x: 0.4, y: 0, z: 0 });
  await page.waitForTimeout(360);
  await expect.poll(() => page.evaluate((id) =>
    window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id)?.media.selectedId,
  panelId)).toBe("albums/beach.jpg");
});

test("filters media with AND tag semantics while retaining directory navigation and filter context", async ({
  page,
}) => {
  const tagServer = {
    tags: [{ id: "horse", name: "Horse" }, { id: "blue", name: "Blue" }],
    assignments: new Map([
      ["albums/beach.jpg", ["horse", "blue"]],
      ["albums/forest.jpg", ["horse"]],
      ["root.jpg", ["horse"]],
    ]),
    requests: [],
    nextId: 1,
  };
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("tag-filter-storage-cleared")) {
      localStorage.clear();
      sessionStorage.setItem("tag-filter-storage-cleared", "true");
    }
  });
  await page.unroute("**/api/**");
  await mockServer(page, { tagServer });
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();
  const panelId = await page.evaluate(() => window.__souvenirApp.store.getState().focusedId);
  await clickSceneObject(page, { action: "browse", panelId });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.browser?.visible)).toBe(true);
  await page.evaluate(() => window.__souvenirApp.browser.open(""));

  await page.evaluate(() => window.__souvenirApp.browser.handleAction("toggle-tag-filter"));
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.browser?.filterMenu.visible)).toBe(true);
  await clickSceneObject(page, { action: "toggle-filter-tag:horse" });
  await clickSceneObject(page, { action: "toggle-filter-tag:blue" });
  await expect.poll(() => page.evaluate(() => ({
    media: window.__souvenirApp.browser.entries.map((entry) => entry.path),
    directories: window.__souvenirApp.browser.workingSubdirectories
      .map((entry) => entry.path),
  }))).toEqual({ media: [], directories: ["albums"] });

  await clickSceneObject(page, { action: "browser-toggle-subdirectories" });
  await clickSceneObject(page, { action: "browser-enter-directory:albums" });
  await expect.poll(() => page.evaluate(() =>
    window.__souvenirApp.browser.entries.map((entry) => entry.path))).toEqual(["albums/beach.jpg"]);
  await clickSceneObject(page, { kind: "browser-entry", entryPath: "albums/beach.jpg" });
  await expect.poll(() => page.evaluate(() => {
    const app = window.__souvenirApp;
    const panel = app.store.getState().panels.find((item) => item.id === app.store.getState().focusedId);
    return {
      selected: panel.media.selectedId,
      playlist: app.runtime.get(panel.id).playlist.map((entry) => entry.path),
    };
  })).toEqual({ selected: "albums/beach.jpg", playlist: ["albums/beach.jpg"] });
  await clickSceneObject(page, { kind: "panel-surface", panelId }, { x: 0.4, y: 0, z: 0 });
  await page.waitForTimeout(360);
  await clickSceneObject(page, { kind: "panel-surface", panelId }, { x: -0.4, y: 0, z: 0 });
  await page.waitForTimeout(360);
  await clickSceneObject(page, { action: "toggle-slideshow", panelId });
  await expect.poll(() => page.evaluate((id) =>
    window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id)?.media.selectedId, panelId))
    .toBe("albums/beach.jpg");

  await clickSceneObject(page, { action: "browse", panelId });
  await page.evaluate(() => window.__souvenirApp.browser.handleAction("toggle-tag-filter"));
  await clickSceneObject(page, { action: "toggle-filter-tag:blue" });
  await expect.poll(() => page.evaluate(() =>
    window.__souvenirApp.browser.entries.map((entry) => entry.path).sort()))
    .toEqual(["albums/beach.jpg", "albums/forest.jpg"]);
  await page.evaluate(() =>
    window.__souvenirApp.browser.filterMenu.handleAction("clear-tag-filter"));
  await expect.poll(() => page.evaluate((id) => window.__souvenirApp.store.getState().panels
    .find((panel) => panel.id === id)?.tagFilter, panelId)).toEqual([]);

  await page.evaluate(() =>
    window.__souvenirApp.browser.filterMenu.handleAction("toggle-filter-tag:horse"));
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("souvenir.layout.v1") ?? "{}");
    return saved.panels?.[0]?.tagFilter;
  })).toEqual(["horse"]);
  await page.reload();
  await page.locator("#preview-button").click();
  await expect.poll(() => page.evaluate(() =>
    window.__souvenirApp.store.getState().panels[0]?.tagFilter)).toEqual(["horse"]);
});

test("navigates enabled directories through cwd, dropdown, parent, and sibling controls", async ({
  page,
}) => {
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();
  const panelId = await page.evaluate(() => window.__souvenirApp.store.getState().focusedId);
  await clickSceneObject(page, { action: "browse", panelId });

  await expect.poll(() => page.evaluate(() => {
    const browser = window.__souvenirApp.browser;
    return {
      cwd: browser?.workingDirectory,
      viewing: browser?.path,
      media: browser?.entries.map((entry) => entry.path),
      subdirectories: browser?.workingSubdirectories.map((entry) => entry.path),
    };
  })).toEqual({
    cwd: "albums",
    viewing: "albums",
    media: expect.arrayContaining(["albums/beach.jpg", "albums/forest.jpg"]),
    subdirectories: ["albums/favorites", "albums/trips"],
  });

  await clickSceneObject(page, { action: "browser-subdirectory-prev" });
  await expect.poll(() => page.evaluate(() => ({
    cwd: window.__souvenirApp.browser.workingDirectory,
    viewing: window.__souvenirApp.browser.path,
    media: window.__souvenirApp.browser.entries.map((entry) => entry.path),
  }))).toEqual({
    cwd: "albums",
    viewing: "albums/trips",
    media: ["albums/trips/road.jpg"],
  });

  await clickSceneObject(page, { action: "browser-directory-current" });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.browser.path))
    .toBe("albums");
  await clickSceneObject(page, { action: "browser-subdirectory-next" });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.browser.path))
    .toBe("albums/favorites");
  await clickSceneObject(page, { action: "browser-subdirectory-next" });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.browser.path))
    .toBe("albums/trips");
  await clickSceneObject(page, { action: "browser-subdirectory-prev" });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.browser.path))
    .toBe("albums/favorites");

  await clickSceneObject(page, { action: "browser-toggle-subdirectories" });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.browser.directoryMenu.visible))
    .toBe(true);
  await clickSceneObject(page, { action: "browser-enter-directory:albums/trips" });
  await expect.poll(() => page.evaluate(() => ({
    cwd: window.__souvenirApp.browser.workingDirectory,
    viewing: window.__souvenirApp.browser.path,
    subdirectories: window.__souvenirApp.browser.workingSubdirectories
      .map((entry) => entry.path),
  }))).toEqual({
    cwd: "albums/trips",
    viewing: "albums/trips",
    subdirectories: ["albums/trips/2026"],
  });

  await clickSceneObject(page, { action: "browser-directory-up" });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.browser.workingDirectory))
    .toBe("albums");
  await clickSceneObject(page, { action: "browser-directory-up" });
  await expect.poll(() => page.evaluate(() => ({
    cwd: window.__souvenirApp.browser.workingDirectory,
    media: window.__souvenirApp.browser.entries.map((entry) => entry.path),
    subdirectories: window.__souvenirApp.browser.workingSubdirectories
      .map((entry) => entry.path),
  }))).toEqual({
    cwd: "",
    media: [],
    subdirectories: ["albums"],
  });
});

test("deleting a tag definition safely reconciles stored filters and assignments", async ({ page }) => {
  const tagServer = {
    tags: [{ id: "blue", name: "Blue" }],
    assignments: new Map([["albums/beach.jpg", ["blue"]]]),
    requests: [],
    nextId: 1,
  };
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("tag-delete-storage-cleared")) {
      localStorage.clear();
      sessionStorage.setItem("tag-delete-storage-cleared", "true");
    }
  });
  await page.unroute("**/api/**");
  await mockServer(page, { tagServer });
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();
  const panelId = await page.evaluate(() => window.__souvenirApp.store.getState().focusedId);
  await clickSceneObject(page, { action: "browse", panelId });
  await page.evaluate(() => window.__souvenirApp.browser.handleAction("toggle-tag-filter"));
  await page.evaluate(() =>
    window.__souvenirApp.browser.filterMenu.handleAction("toggle-filter-tag:blue"));
  await expect.poll(() => page.evaluate((id) =>
    window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id)?.tagFilter, panelId))
    .toEqual(["blue"]);

  await page.locator("#exit-preview").click();
  await page.getByRole("button", { name: "Delete Blue", exact: true }).click();
  await expect.poll(() => tagServer.assignments.get("albums/beach.jpg")).toEqual([]);
  await page.locator("#preview-button").click();
  await expect.poll(() => page.evaluate((id) =>
    window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id)?.tagFilter, panelId))
    .toEqual([]);
  await page.evaluate(() => localStorage.clear());
});

test("discards stale saved media after the library root changes", async ({ page }) => {
  const requests = [];
  const libraryId = "/g/Intel";
  const currentTree = {
    name: "Intel",
    path: "",
    kind: "directory",
    children: [{ name: "cm2", path: "cm2", kind: "directory", children: [] }],
  };
  const currentEntries = {
    "": [{
      name: "cm2",
      path: "cm2",
      kind: "directory",
      media_type: null,
      size: null,
      mtime: "2026-08-23T00:00:00Z",
    }],
    cm2: [{
      name: "P144.jpg",
      path: "cm2/P144.jpg",
      kind: "file",
      media_type: "image/jpeg",
      size: 144,
      mtime: "2026-08-23T00:00:00Z",
      url: "/api/file?path=cm2%2FP144.jpg",
      thumbnail_url: "/api/thumbnail?path=cm2%2FP144.jpg",
    }],
  };

  await page.unroute("**/api/**");
  await mockServer(page, {
    libraryId,
    tree: currentTree,
    mediaEntries: currentEntries,
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      "souvenir.layout.v1",
      JSON.stringify({
        libraryId: "/g/Intel-before-root-switch",
        focusedId: "stale-panel",
        panels: [{
          id: "stale-panel",
          media: {
            directory: "Intel/cm2",
            selectedId: "Intel/cm2/P144.jpg",
            sort: "name",
            view: "names",
          },
        }],
        runtime: {
          "stale-panel": {
            playlist: [{
              name: "P144.jpg",
              path: "Intel/cm2/P144.jpg",
              kind: "file",
              media_type: "image/jpeg",
            }],
            slideshow: { active: true },
          },
        },
      }),
    );
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (pathname === "/api/media" || pathname === "/api/file") {
      requests.push({
        pathname,
        path: url.searchParams.get("path"),
        url: decodeURIComponent(request.url()),
      });
    }
  });

  await page.goto("/?debug=1");
  await expect(page.locator('.directory-row input[value="cm2"]')).toBeVisible();
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();

  const cleared = await page.evaluate(() => {
    const app = window.__souvenirApp;
    const panel = app.store.getState().panels[0];
    return {
      panelCount: app.store.getState().panels.length,
      stalePanelPresent: app.store.getState().panels.some((item) => item.id === "stale-panel"),
      selectedId: panel.media.selectedId,
      directory: panel.media.directory,
      mediaType: app.panelViews.get(panel.id)?.mediaType,
    };
  });
  expect(cleared).toEqual({
    panelCount: 1,
    stalePanelPresent: false,
    selectedId: null,
    directory: null,
    mediaType: null,
  });
  expect(requests.map((request) => request.url)).not.toContainEqual(
    expect.stringContaining("Intel/cm2"),
  );

  const panelId = await page.evaluate(() => window.__souvenirApp.store.getState().focusedId);
  await clickSceneObject(page, { action: "browse", panelId });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.browser?.visible)).toBe(true);
  await clickSceneObject(page, { action: "browser-toggle-subdirectories" });
  await clickSceneObject(page, { action: "browser-enter-directory:cm2" });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.browser?.path)).toBe("cm2");
  await clickSceneObject(page, { kind: "browser-entry", entryPath: "cm2/P144.jpg" });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].media.selectedId),
  ).toBe("cm2/P144.jpg");
  await expect.poll(() =>
    requests.some(
      (request) =>
        request.pathname === "/api/file" && request.path === "cm2/P144.jpg",
    ),
  ).toBe(true);
  expect(requests.map((request) => request.url)).not.toContainEqual(
    expect.stringContaining("Intel/cm2"),
  );
});
