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

test("cycles image display modes only for nearby rapid double taps", async ({ page }) => {
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();

  const panelId = await page.evaluate(
    () => window.__souvenirApp.store.getState().focusedId,
  );
  await clickSceneObject(page, { action: "browse", panelId });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.browser?.visible)).toBe(true);
  await clickSceneObject(page, {
    kind: "browser-entry",
    entryPath: "albums/beach.jpg",
  });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].media.selectedId),
  ).toBe("albums/beach.jpg");

  const surfaceState = () => page.evaluate((id) => {
    const surface = window.__souvenirApp.panelViews.get(id).surface;
    const texture = surface.material.map;
    return {
      scale: surface.scale.toArray(),
      position: surface.position.toArray(),
      repeat: texture.repeat.toArray(),
      offset: texture.offset.toArray(),
    };
  }, panelId);
  const fitSurface = await surfaceState();

  await doubleTapSceneObject(page, { kind: "panel-surface", panelId });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].displayMode),
  ).toBe("actual");
  const actualSurface = await surfaceState();
  expect(actualSurface).not.toEqual(fitSurface);

  await doubleTapSceneObject(page, { kind: "panel-surface", panelId });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].displayMode),
  ).toBe("fill");
  const fillSurface = await surfaceState();
  expect(fillSurface).not.toEqual(actualSurface);

  await doubleTapSceneObject(page, { kind: "panel-surface", panelId });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].displayMode),
  ).toBe("fit");

  await page.waitForTimeout(450);
  await clickSceneObject(page, { kind: "panel-surface", panelId }, { x: 0.4, y: 0, z: 0 });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].media.selectedId),
  ).toBe("albums/forest.jpg");

  await page.waitForTimeout(450);
  await clickSceneObject(page, { kind: "panel-surface", panelId }, { x: -0.4, y: 0, z: 0 });
  await page.waitForTimeout(25);
  await clickSceneObject(page, { kind: "panel-surface", panelId }, { x: 0.4, y: 0, z: 0 });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].media.selectedId),
  ).toBe("albums/forest.jpg");
  expect(await page.evaluate(
    () => window.__souvenirApp.store.getState().panels[0].displayMode,
  )).toBe("fit");

  await page.waitForTimeout(450);
  await page.evaluate((id) => {
    const view = window.__souvenirApp.panelViews.get(id);
    window.__videoTapCalls = 0;
    view.mediaType = "video";
    view.mediaTexture.video = {
      paused: true,
      play() {
        window.__videoTapCalls += 1;
        return Promise.resolve();
      },
    };
  }, panelId);
  await clickSceneObject(page, { kind: "panel-surface", panelId });
  expect(await page.evaluate(() => window.__videoTapCalls)).toBe(1);
});

test("cycles persistent panel aspect ratios using loaded native image dimensions", async ({
  page,
}) => {
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();

  const panelId = await page.evaluate(
    () => window.__souvenirApp.store.getState().focusedId,
  );
  await clickSceneObject(page, { action: "browse", panelId });
  await clickSceneObject(page, {
    kind: "browser-entry",
    entryPath: "albums/beach.jpg",
  });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].media.selectedId),
  ).toBe("albums/beach.jpg");

  const panelState = () => page.evaluate(() => window.__souvenirApp.store.getState().panels[0]);
  const expectRatio = async (mode, height) => {
    await expect.poll(async () => (await panelState()).aspectRatioMode).toBe(mode);
    await expect.poll(async () => (await panelState()).dimensions.width).toBe(1.2);
    await expect.poll(async () => (await panelState()).dimensions.height).toBeCloseTo(height, 8);
  };

  await expectRatio("native", 0.675);
  await expect(page.locator("canvas")).toBeVisible();
  await expect.poll(() => page.evaluate((id) => {
    const view = window.__souvenirApp.panelViews.get(id);
    return view.controls.children.some(
      (control) =>
        control.userData.action === "cycle-aspect-ratio" &&
        control.userData.label === "Ratio",
    );
  }, panelId)).toBe(true);

  for (const [mode, height] of [
    ["1:1", 1.2],
    ["4:3", 0.9],
    ["3:2", 0.8],
    ["16:9", 0.675],
  ]) {
    await clickSceneObject(page, { action: "cycle-aspect-ratio", panelId });
    await expectRatio(mode, height);
    await expect.poll(() =>
      page.evaluate((id) => window.__souvenirApp.panelViews.get(id).modeIndicator.visible, panelId),
    ).toBe(true);
  }

  await doubleTapSceneObject(page, { kind: "panel-surface", panelId });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].displayMode),
  ).toBe("actual");
  await expectRatio("16:9", 0.675);

  await clickSceneObject(page, { action: "cycle-aspect-ratio", panelId });
  await expectRatio("9:16", 2.1333333333333333);
  await clickSceneObject(page, { action: "cycle-aspect-ratio", panelId });
  await expectRatio("native", 0.675);

  await page.locator("#exit-preview").click();
  await page.reload();
  await page.locator("#preview-button").click();
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].aspectRatioMode),
  ).toBe("native");
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].dimensions.width),
  ).toBe(1.2);
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].dimensions.height),
  ).toBeCloseTo(0.675, 8);

  const restoredPanelId = await page.evaluate(
    () => window.__souvenirApp.store.getState().focusedId,
  );
  await clickSceneObject(page, { action: "browse", panelId: restoredPanelId });
  await clickSceneObject(page, {
    kind: "browser-entry",
    entryPath: "albums/forest.jpg",
  });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].media.selectedId),
  ).toBe("albums/forest.jpg");
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].dimensions.width),
  ).toBe(1.2);
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].dimensions.height),
  ).toBeCloseTo(1.6, 8);
});

test("keeps the newest native image texture after an earlier image load resolves", async ({
  page,
}) => {
  await page.unroute("**/api/**");
  await mockServer(page, { imageDelays: { "albums/beach.jpg": 650 } });
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();

  const panelId = await page.evaluate(
    () => window.__souvenirApp.store.getState().focusedId,
  );
  await clickSceneObject(page, { action: "browse", panelId });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.browser?.entries.map((entry) => entry.path)),
  ).toContain("albums/beach.jpg");

  await page.evaluate(async () => {
    const { browser } = window.__souvenirApp;
    const beach = browser.entries.find((entry) => entry.path === "albums/beach.jpg");
    const forest = browser.entries.find((entry) => entry.path === "albums/forest.jpg");
    await browser.activateEntry(beach);
    await browser.activateEntry(forest);
  });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].media.selectedId),
  ).toBe("albums/forest.jpg");

  const readFinalMedia = () => page.evaluate((id) => {
    const app = window.__souvenirApp;
    const view = app.panelViews.get(id);
    const image = view?.surface.material.map?.image;
    if (!image) return null;
    return {
      texture: {
        width: image.naturalWidth ?? image.width,
        height: image.naturalHeight ?? image.height,
      },
      mediaSize: view.mediaSize,
      dimensions: app.store.getState().panels[0].dimensions,
      aspectRatioMode: app.store.getState().panels[0].aspectRatioMode,
    };
  }, panelId);
  await expect.poll(readFinalMedia).toMatchObject({
    texture: { width: 1200, height: 1600 },
    mediaSize: { width: 1200, height: 1600 },
    dimensions: { width: 1.2 },
    aspectRatioMode: "native",
  });
  const finalMedia = await readFinalMedia();
  expect(finalMedia.dimensions.height).toBeCloseTo(1.6, 8);
});

test("edits a shared erase mask without allowing panel gestures or media navigation while drawing", async ({
  page,
}) => {
  const maskServer = { masks: new Map(), requests: [] };
  await page.unroute("**/api/**");
  await mockServer(page, { maskServer });
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();

  const panelId = await page.evaluate(() => window.__souvenirApp.store.getState().focusedId);
  await selectBeachImage(page, panelId);
  await expect.poll(() => page.evaluate((id) => {
    const view = window.__souvenirApp.panelViews.get(id);
    return view?.mediaType;
  }, panelId)).toBe("image");

  const controls = await page.evaluate((id) => {
    const view = window.__souvenirApp.panelViews.get(id);
    return view.controls.children
      .map((control) => ({ action: control.userData.action, label: control.userData.label }));
  }, panelId);
  expect(controls).toEqual(expect.arrayContaining([
    { action: "edit-erase-mask", label: "Erase BG" },
    { action: "toggle-mask", label: "Mask" },
  ]));

  const beforeDraw = await page.evaluate((id) => ({
    displayMode: window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id).displayMode,
    selectedId: window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id).media.selectedId,
  }), panelId);
  await clickSceneObject(page, { action: "edit-erase-mask", panelId });
  await expect.poll(() => page.evaluate((id) => {
    const view = window.__souvenirApp.panelViews.get(id);
    return {
      editor: view?.editorActive,
      dragDisabled: view?.surface.userData.gestureTarget === false,
      drawEnabled: typeof view?.surface.userData.drawTarget?.onDraw === "function",
      hoverEnabled: typeof view?.surface.userData.drawTarget?.onHover === "function",
      sliderActions: [view?.brushSlider, view?.blurSlider]
        .map((slider) => slider?.track.userData.action),
      oldStepActions: view?.editorControls.children
        .map((control) => control.userData.action)
        .filter((action) => action?.includes("increase") || action?.includes("decrease")),
    };
  }, panelId)).toEqual({
    editor: true,
    dragDisabled: true,
    drawEnabled: true,
    hoverEnabled: true,
    sliderActions: ["mask-brush-slider", "mask-blur-slider"],
    oldStepActions: [],
  });

  const hoverPoint = await sceneObjectScreenPoint(
    page,
    { kind: "panel-surface", panelId },
    { x: 0.1, y: 0.1, z: 0 },
  );
  await page.mouse.move(hoverPoint.x, hoverPoint.y);
  await expect.poll(() => page.evaluate((id) => {
    const cursor = window.__souvenirApp.panelViews.get(id)?.brushCursor;
    return {
      visible: cursor?.visible,
      positiveSize: cursor?.scale.x > 0 && cursor?.scale.y > 0,
    };
  }, panelId)).toMatchObject({
    visible: true,
    positiveSize: true,
  });

  await paintAcrossPanelSurface(page, panelId);
  await expect.poll(() => page.evaluate(() => {
    const editor = window.__souvenirApp.maskEditor;
    return editor?.canvas.getContext("2d").getImageData(
      0,
      0,
      editor.canvas.width,
      editor.canvas.height,
    ).data.some((value, index) => index % 4 === 3 && value > 0);
  })).toBe(true);
  await page.waitForTimeout(400);
  expect(await page.evaluate((id) => ({
    displayMode: window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id).displayMode,
    selectedId: window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id).media.selectedId,
  }), panelId)).toEqual(beforeDraw);

  await clickSceneObject(page, { action: "mask-brush-slider", panelId });
  await clickSceneObject(page, { action: "mask-blur-slider", panelId });
  await expect.poll(() => page.evaluate(() => ({
    brushPercent: Math.round((window.__souvenirApp.maskEditor?.brushSize ?? 0) * 100),
    blur: window.__souvenirApp.maskEditor?.blur,
  }))).toEqual({ brushPercent: 11, blur: 32 });
  await clickSceneObject(page, { action: "mask-apply", panelId });
  await expect.poll(() => maskServer.requests).toHaveLength(1);
  expect(maskServer.requests[0]).toMatchObject({
    method: "PUT",
    path: "albums/beach.jpg",
    blur: 32,
  });
  expect(maskServer.requests[0].png.length).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate((id) => {
    const view = window.__souvenirApp.panelViews.get(id);
    return {
      editor: view?.editorActive,
      alphaMap: Boolean(view?.surface.material.alphaMap),
      transparent: view?.surface.material.transparent,
      depthWrite: view?.surface.material.depthWrite,
      frameVisible: view?.frame.visible,
    };
  }, panelId)).toEqual({
    editor: false,
    alphaMap: true,
    transparent: true,
    depthWrite: false,
    frameVisible: false,
  });

  await clickSceneObject(page, { action: "add-panel" });
  const secondPanelId = await page.evaluate(() => window.__souvenirApp.store.getState().focusedId);
  await selectBeachImage(page, secondPanelId);
  await expect.poll(() => page.evaluate((id) =>
    Boolean(window.__souvenirApp.panelViews.get(id)?.surface.material.alphaMap), secondPanelId,
  )).toBe(true);

  await clickSceneObject(page, { action: "toggle-mask", panelId: secondPanelId });
  await expect.poll(() => page.evaluate((id) => ({
    enabled: window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id).maskEnabled,
    alphaMap: Boolean(window.__souvenirApp.panelViews.get(id)?.surface.material.alphaMap),
  }), secondPanelId)).toEqual({ enabled: false, alphaMap: false });
  expect(await page.evaluate((id) => ({
    enabled: window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id).maskEnabled,
    alphaMap: Boolean(window.__souvenirApp.panelViews.get(id)?.surface.material.alphaMap),
  }), panelId)).toEqual({ enabled: true, alphaMap: true });
  await clickSceneObject(page, { action: "toggle-mask", panelId: secondPanelId });
  await expect.poll(() => page.evaluate((id) =>
    window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id)?.maskEnabled,
  secondPanelId)).toBe(true);
  await clickSceneObject(page, { action: "toggle-mask", panelId: secondPanelId });

  await page.locator("#exit-preview").click();
  await page.reload();
  await page.locator("#preview-button").click();
  await expect.poll(() => page.evaluate(() => {
    const [first, second] = window.__souvenirApp.store.getState().panels;
    return {
      firstMaskEnabled: first.maskEnabled,
      secondMaskEnabled: second.maskEnabled,
      serverMaskLoaded: Boolean(window.__souvenirApp.panelViews.get(first.id)?.surface.material.alphaMap),
    };
  })).toEqual({
    firstMaskEnabled: true,
    secondMaskEnabled: false,
    serverMaskLoaded: true,
  });
});

test("cancels an active editor when the real panel store advances to another image", async ({
  page,
}) => {
  const maskServer = { masks: new Map(), requests: [] };
  await page.unroute("**/api/**");
  await mockServer(page, { maskServer });
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();

  const panelId = await page.evaluate(() => window.__souvenirApp.store.getState().focusedId);
  await selectBeachImage(page, panelId);
  await clickSceneObject(page, { action: "edit-erase-mask", panelId });
  await paintAcrossPanelSurface(page, panelId);
  await expect.poll(() => page.evaluate((id) =>
    Boolean(window.__souvenirApp.maskEditor?.canvas)
      && typeof window.__souvenirApp.panelViews.get(id)?.surface.userData.drawTarget?.onDraw === "function",
  panelId)).toBe(true);

  await page.evaluate((id) => {
    const app = window.__souvenirApp;
    app.store.setMedia(id, "albums/forest.jpg");
  }, panelId);
  await expect.poll(() => page.evaluate((id) => {
    const app = window.__souvenirApp;
    const view = app.panelViews.get(id);
    return {
      selectedId: app.store.getState().panels.find((panel) => panel.id === id)?.media.selectedId,
      editor: app.maskEditor,
      editorActive: view?.editorActive,
      drawTarget: view?.surface.userData.drawTarget,
      mask: Boolean(view?.surface.material.alphaMap),
      mediaType: view?.mediaType,
    };
  }, panelId)).toEqual({
    selectedId: "albums/forest.jpg",
    editor: null,
    editorActive: false,
    drawTarget: undefined,
    mask: false,
    mediaType: "image",
  });
  expect(maskServer.requests).toEqual([]);
});

test("loads a generated WebM mask into a VideoTexture and toggles it per panel", async ({ page }) => {
  await page.goto("about:blank");
  const video = await createTinyWebm(page);
  const maskPng = await createMaskPng(page);
  const maskServer = {
    masks: new Map([[
      "albums/tiny.webm",
      { png: maskPng, blur: 2, updatedAt: "2026-08-23T00:00:00Z" },
    ]]),
    requests: [],
  };
  await page.unroute("**/api/**");
  await mockServer(page, {
    maskServer,
    videoFixtures: { "albums/tiny.webm": video },
    extraEntries: {
      albums: [{
        name: "tiny.webm",
        path: "albums/tiny.webm",
        kind: "file",
        media_type: "video/webm",
        size: video.length,
        mtime: "2026-08-23T00:00:00Z",
        url: "/api/file?path=albums%2Ftiny.webm",
        thumbnail_url: "/api/thumbnail?path=albums%2Ftiny.webm",
      }],
    },
  });
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();

  const panelId = await page.evaluate(() => window.__souvenirApp.store.getState().focusedId);
  await clickSceneObject(page, { action: "browse", panelId });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.browser?.visible)).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    window.__souvenirApp.browser?.entries.some((entry) => entry.path === "albums/tiny.webm"),
  )).toBe(true);
  await page.evaluate(async () => {
    const { browser } = window.__souvenirApp;
    await browser.activateEntry(browser.entries.find((entry) => entry.path === "albums/tiny.webm"));
  });
  await expect.poll(() => page.evaluate((id) => {
    const view = window.__souvenirApp.panelViews.get(id);
    return {
      selectedId: window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id)?.media.selectedId,
      mediaType: view?.mediaType,
      isVideoTexture: Boolean(view?.surface.material.map?.isVideoTexture),
      alphaMap: Boolean(view?.surface.material.alphaMap),
      transparent: view?.surface.material.transparent,
      depthWrite: view?.surface.material.depthWrite,
      frameVisible: view?.frame.visible,
    };
  }, panelId)).toEqual({
    selectedId: "albums/tiny.webm",
    mediaType: "video",
    isVideoTexture: true,
    alphaMap: true,
    transparent: true,
    depthWrite: false,
    frameVisible: false,
  });

  await clickSceneObject(page, { action: "toggle-mask", panelId });
  await expect.poll(() => page.evaluate((id) => ({
    enabled: window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id)?.maskEnabled,
    alphaMap: Boolean(window.__souvenirApp.panelViews.get(id)?.surface.material.alphaMap),
    transparent: window.__souvenirApp.panelViews.get(id)?.surface.material.transparent,
    depthWrite: window.__souvenirApp.panelViews.get(id)?.surface.material.depthWrite,
    frameVisible: window.__souvenirApp.panelViews.get(id)?.frame.visible,
  }), panelId)).toEqual({
    enabled: false,
    alphaMap: false,
    transparent: false,
    depthWrite: true,
    frameVisible: true,
  });
  await clickSceneObject(page, { action: "toggle-mask", panelId });
  await expect.poll(() => page.evaluate((id) => ({
    enabled: window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id)?.maskEnabled,
    alphaMap: Boolean(window.__souvenirApp.panelViews.get(id)?.surface.material.alphaMap),
    transparent: window.__souvenirApp.panelViews.get(id)?.surface.material.transparent,
    depthWrite: window.__souvenirApp.panelViews.get(id)?.surface.material.depthWrite,
    frameVisible: window.__souvenirApp.panelViews.get(id)?.frame.visible,
  }), panelId)).toEqual({
    enabled: true,
    alphaMap: true,
    transparent: true,
    depthWrite: false,
    frameVisible: false,
  });
});
