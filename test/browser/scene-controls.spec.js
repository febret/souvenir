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

test("moves the media browser from its grab surface without breaking entry selection", async ({
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
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.browser?.visible),
  ).toBe(true);

  const browserDetails = await page.evaluate(() => {
    const app = window.__souvenirApp;
    const textureDimensions = (texture) => {
      const source = texture?.source?.data ?? texture?.image;
      return source
        ? {
            width: source.width,
            height: source.height,
            isCanvas: source instanceof HTMLCanvasElement,
          }
        : null;
    };
    let surface = null;
    let entry = null;
    app.browser.traverse((object) => {
      if (!surface && object.userData.kind === "browser-surface") surface = object;
      if (!entry && object.userData.kind === "browser-entry") entry = object;
    });
    const control = app.browser.controls.children.find(
      (object) => object.userData.action === "browser-view",
    );
    return {
      surface: surface
        ? {
            interactive: surface.userData.interactive,
            kind: surface.userData.kind,
          }
        : null,
      backdrop: textureDimensions(app.browser.backdrop.material.map),
      entry: textureDimensions(entry?.material?.map),
      control: textureDimensions(control?.material?.map),
    };
  });

  expect(browserDetails.surface).toEqual({
    interactive: true,
    kind: "browser-surface",
  });
  for (const [name, dimensions, minimum] of [
    ["backdrop", browserDetails.backdrop, { width: 2400, height: 1600 }],
    ["entry", browserDetails.entry, { width: 1280, height: 320 }],
    ["control", browserDetails.control, { width: 1024, height: 256 }],
  ]) {
    expect(dimensions, `Expected a canvas-backed ${name} texture`).toMatchObject({
      isCanvas: true,
    });
    expect(dimensions.width, `${name} texture width`).toBeGreaterThanOrEqual(
      minimum.width,
    );
    expect(dimensions.height, `${name} texture height`).toBeGreaterThanOrEqual(
      minimum.height,
    );
  }

  const beforeDrag = await page.evaluate(() => {
    const browser = window.__souvenirApp.browser;
    return {
      position: browser.position.toArray(),
      quaternion: browser.quaternion.toArray(),
    };
  });
  await dragSceneObject(
    page,
    { kind: "browser-surface" },
    { x: 0, y: 0.35, z: 0 },
  );
  await expect.poll(() =>
    page.evaluate((before) => {
      const browser = window.__souvenirApp.browser;
      return browser.position.distanceTo({
        x: before.position[0],
        y: before.position[1],
        z: before.position[2],
      });
    }, beforeDrag),
  ).toBeGreaterThan(0.05);
  const afterDrag = await page.evaluate(() => {
    const browser = window.__souvenirApp.browser;
    return {
      position: browser.position.toArray(),
      quaternion: browser.quaternion.toArray(),
    };
  });
  expect(afterDrag.quaternion).toHaveLength(4);
  expect(
    Math.hypot(...afterDrag.quaternion),
    "Browser quaternion should remain a valid transform after dragging",
  ).toBeCloseTo(1, 5);

  await clickSceneObject(page, {
    kind: "browser-entry",
    entryPath: "albums/beach.jpg",
  });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels[0].media.selectedId),
  ).toBe("albums/beach.jpg");
});

test("applies absolute two-hand panel and browser gestures without moving controls", async ({
  page,
}) => {
  // This is a synthetic absolute-gesture contract test, not a desktop simulation of
  // two WebXR controllers. Quest smoke check: grab a panel with both controllers,
  // spread/rotate it, release one controller, then verify the remaining grab is smooth.
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();

  const panelId = await page.evaluate(() => window.__souvenirApp.store.getState().focusedId);
  const result = await page.evaluate((id) => {
    const app = window.__souvenirApp;
    app.applyGesture(id, {
      hands: 2,
      gestureId: "panel-two-hand",
      absolutePose: {
        position: { x: 0.37, y: 1.62, z: -1.8 },
        rotation: { x: 0.1, y: -0.2, z: 0.05 },
      },
      absoluteDimensions: { width: 1.8, height: 1.2 },
    });
    const pairStartDimensions = app.store.getState().panels.find((item) => item.id === id).dimensions;
    app.applyGesture(id, {
      hands: 2,
      gestureId: "panel-two-hand",
      absolutePose: {
        position: { x: 0.37, y: 1.62, z: -1.8 },
        rotation: { x: 0.1, y: -0.2, z: 0.05 },
      },
      absoluteDimensions: { width: 1.8, height: 1.2 },
    });
    const panel = app.store.getState().panels.find((item) => item.id === id);
    const view = app.panelViews.get(id);
    app.store.setLocked(id, true);
    const lockedPosition = { ...panel.transform.position };
    app.applyGesture(id, {
      hands: 2,
      absolutePose: {
        position: { x: 4, y: 4, z: 4 },
        rotation: { x: 1, y: 1, z: 1 },
      },
      absoluteDimensions: { width: 3, height: 2 },
    });
    const locked = app.store.getState().panels.find((item) => item.id === id);
    app.store.setLocked(id, false);
    app.store.minimize(id);
    app.applyGesture(id, {
      hands: 2,
      absolutePose: {
        position: { x: 0.5, y: 1.5, z: -1.6 },
        rotation: { x: 0, y: 0.3, z: 0 },
      },
      absoluteDimensions: { width: 3, height: 2 },
    });
    const minimized = app.store.getState().panels.find((item) => item.id === id);
    app.store.restore(id);
    return {
      panel,
      pairStartDimensions,
      manipulation: view.userData.manipulation,
      locked,
      lockedPosition,
      minimized,
    };
  }, panelId);

  expect(result.panel.transform).toEqual({
    position: { x: 0.37, y: 1.62, z: -1.8 },
    rotation: { x: 0.1, y: -0.2, z: 0.05 },
  });
  expect(result.panel.dimensions).toEqual({ width: 1.8, height: 1.2 });
  expect(result.pairStartDimensions).toEqual(result.panel.dimensions);
  expect(result.manipulation.dimensions).toEqual({ width: 1.8, height: 1.2 });
  expect(result.manipulation.scaleLimits.min).toBeGreaterThan(0);
  expect(result.locked.transform.position).toEqual(result.lockedPosition);
  expect(result.locked.dimensions).toEqual({ width: 1.8, height: 1.2 });
  expect(result.minimized.dimensions).toEqual({ width: 0.28, height: 0.18 });
  expect(result.minimized.transform.position).toEqual({ x: 0.5, y: 1.5, z: -1.6 });

  await clickSceneObject(page, { action: "browse", panelId });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.browser?.visible)).toBe(true);
  const browser = await page.evaluate(() => {
    const app = window.__souvenirApp;
    const control = app.browser.controls.children[0];
    app.applyGesture(app.browser.interactionTarget, {
      hands: 2,
      gestureId: "browser-two-hand",
      absolutePose: {
        position: { x: -0.4, y: 1.4, z: -1.7 },
        rotation: { x: 0.05, y: 0.2, z: -0.1 },
      },
      absoluteObjectScale: 3,
    });
    return {
      position: app.browser.position.toArray(),
      rotation: app.browser.rotation.toArray(),
      scale: app.browser.scale.toArray(),
      metadata: app.browser.userData.manipulation,
      controlGestureTarget: control.userData.gestureTarget,
      controlScale: control.scale.toArray(),
    };
  });
  expect(browser.position).toEqual([-0.4, 1.4, -1.7]);
  expect(browser.scale).toEqual([2.5, 2.5, 2.5]);
  expect(browser.metadata).toMatchObject({ type: "browser", scalable: true });
  expect(browser.controlGestureTarget).toBe(false);
  expect(browser.controlScale).toEqual([1, 1, 1]);
});

test("moves the titled main toolbar while keeping its canvas controls activation-only", async ({
  page,
}) => {
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();

  const toolbarDetails = await page.evaluate(() => {
    const app = window.__souvenirApp;
    let surface = null;
    let add = null;
    let remove = null;
    let title = null;
    app.toolbar.traverse((object) => {
      if (!surface && object.userData.kind === "toolbar-surface") surface = object;
      if (!add && object.userData.action === "add-panel") add = object;
      if (!remove && object.userData.action === "remove-panel") remove = object;
      if (!title && typeof object.userData.title === "string") title = object.userData.title;
    });
    const textureDimensions = (object) => {
      const texture = object?.material?.map;
      const source = texture?.source?.data ?? texture?.image;
      return source
        ? {
            width: source.width,
            height: source.height,
            isCanvas: source instanceof HTMLCanvasElement,
          }
        : null;
    };
    const { width = 0, height = 0 } = surface?.geometry?.parameters ?? {};
    return {
      surface: surface
        ? {
            interactive: surface.userData.interactive,
            kind: surface.userData.kind,
          }
        : null,
      title: title ?? app.toolbar.userData.title,
      backdrop: textureDimensions(surface),
      add: textureDimensions(add),
      remove: textureDimensions(remove),
      dragPoint: { x: 0, y: height * 0.28, z: 0 },
    };
  });

  expect(toolbarDetails.surface).toEqual({
    interactive: true,
    kind: "toolbar-surface",
  });
  expect(toolbarDetails.title, "Toolbar title should be available as userData metadata").toEqual(
    expect.any(String),
  );
  expect(toolbarDetails.title.trim()).not.toBe("");
  for (const [name, dimensions, minimum] of [
    ["toolbar backdrop", toolbarDetails.backdrop, { width: 1600, height: 500 }],
    ["Add button", toolbarDetails.add, { width: 1024, height: 256 }],
    ["Remove button", toolbarDetails.remove, { width: 1024, height: 256 }],
  ]) {
    expect(dimensions, `Expected a canvas-backed ${name} texture`).toMatchObject({
      isCanvas: true,
    });
    expect(dimensions.width, `${name} texture width`).toBeGreaterThanOrEqual(minimum.width);
    expect(dimensions.height, `${name} texture height`).toBeGreaterThanOrEqual(minimum.height);
  }

  const beforeDrag = await page.evaluate(() => ({
    position: window.__souvenirApp.toolbar.position.toArray(),
    quaternion: window.__souvenirApp.toolbar.quaternion.toArray(),
  }));
  await dragSceneObject(page, { kind: "toolbar-surface" }, toolbarDetails.dragPoint);
  await expect.poll(() =>
    page.evaluate((before) =>
      window.__souvenirApp.toolbar.position.distanceTo({
        x: before.position[0],
        y: before.position[1],
        z: before.position[2],
      }), beforeDrag),
  ).toBeGreaterThan(0.05);
  const afterDrag = await page.evaluate(() => ({
    position: window.__souvenirApp.toolbar.position.toArray(),
    quaternion: window.__souvenirApp.toolbar.quaternion.toArray(),
  }));
  expect(Math.hypot(...afterDrag.quaternion)).toBeCloseTo(1, 5);

  const panelCount = await page.evaluate(() => window.__souvenirApp.store.getState().panels.length);
  await clickSceneObject(page, { action: "add-panel" });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels.length),
  ).toBe(panelCount + 1);
  await clickSceneObject(page, { action: "remove-panel" });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels.length),
  ).toBe(panelCount);

  await dragSceneObject(page, { action: "add-panel" });
  const afterButtonDrag = await page.evaluate(() => ({
    position: window.__souvenirApp.toolbar.position.toArray(),
    panelCount: window.__souvenirApp.store.getState().panels.length,
  }));
  expect(afterButtonDrag.position).toEqual(afterDrag.position);
  expect(afterButtonDrag.panelCount).toBe(panelCount);
});

test("chooses persistent background-only environment effects from the toolbar", async ({
  page,
}) => {
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();

  const panelMaterial = await page.evaluate(() => {
    const panelId = window.__souvenirApp.store.getState().focusedId;
    const material = window.__souvenirApp.panelViews.get(panelId).surface.material;
    return {
      color: material.color.getHex(),
      opacity: material.opacity,
      transparent: material.transparent,
    };
  });

  await clickSceneObject(page, { action: "toggle-environment-menu" });
  if (!await page.evaluate(() => window.__souvenirApp.toolbar.environmentMenu.visible)) {
    await clickSceneObject(page, { action: "toggle-environment-menu" });
  }
  await expect.poll(() => page.evaluate(() => {
    const { environmentMenu, environmentButtons } = window.__souvenirApp.toolbar;
    return {
      visible: environmentMenu.visible,
      title: environmentMenu.userData.title,
      actions: [...environmentButtons.values()].map((button) => button.userData.action),
      visibleActions: [...environmentButtons.values()].filter(
        (button) => button.visible && button.parent.visible,
      ).length,
    };
  })).toEqual({
    visible: true,
    title: "ENVIRONMENT",
    actions: [
      "set-environment:normal",
      "set-environment:dark",
      "set-environment:night",
      "set-environment:underwater",
      "set-environment:red",
    ],
    visibleActions: 5,
  });

  await clickSceneObject(page, { action: "toggle-environment-menu" });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.toolbar.environmentMenu.visible),
  ).toBe(false);
  await clickSceneObject(page, { action: "set-environment:red" });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.environmentMode),
  ).toBe("normal");

  const modes = [
    { mode: "normal", color: 0x000000, opacity: 0, underwater: 0, visible: false },
    { mode: "dark", color: 0x000000, opacity: 0.42, underwater: 0, visible: true },
    { mode: "night", color: 0x07162f, opacity: 0.45, underwater: 0, visible: true },
    { mode: "underwater", color: 0x087eaa, opacity: 0.38, underwater: 1, visible: true },
    { mode: "red", color: 0x75070c, opacity: 0.4, underwater: 0, visible: true },
  ];
  const effects = new Map();
  for (const expected of modes) {
    await clickSceneObject(page, { action: "toggle-environment-menu" });
    await expect.poll(() =>
      page.evaluate(() => window.__souvenirApp.toolbar.environmentMenu.visible),
    ).toBe(true);
    await clickSceneObject(page, { action: `set-environment:${expected.mode}` });
    await expect.poll(() => page.evaluate(() => {
      const app = window.__souvenirApp;
      const material = app.environmentEffects.material;
      return {
        mode: app.environmentMode,
        toolbarMode: app.toolbar.environmentMode,
        selected: app.toolbar.environmentButtons.get(app.environmentMode)?.userData.selected,
        menuVisible: app.toolbar.environmentMenu.visible,
        visible: app.environmentEffects.mesh.visible,
        color: material.uniforms.uColor.value.getHex(),
        opacity: material.uniforms.uOpacity.value,
        underwater: material.uniforms.uUnderwater.value,
        panel: {
          color: app.panelViews.get(app.store.getState().focusedId).surface.material.color.getHex(),
          opacity: app.panelViews.get(app.store.getState().focusedId).surface.material.opacity,
          transparent: app.panelViews.get(app.store.getState().focusedId).surface.material.transparent,
        },
      };
    })).toMatchObject({
      mode: expected.mode,
      toolbarMode: expected.mode,
      selected: true,
      menuVisible: false,
      visible: expected.visible,
      color: expected.color,
      underwater: expected.underwater,
      panel: panelMaterial,
    });
    const effect = await page.evaluate(() => {
      const material = window.__souvenirApp.environmentEffects.material;
      return {
        color: material.uniforms.uColor.value.getHex(),
        opacity: material.uniforms.uOpacity.value,
      };
    });
    expect(effect.opacity).toBeCloseTo(expected.opacity);
    effects.set(expected.mode, effect);
  }
  expect(effects.get("dark")).not.toEqual(effects.get("night"));
  expect(effects.get("dark")).not.toEqual(effects.get("red"));
  expect(effects.get("night")).not.toEqual(effects.get("red"));

  await clickSceneObject(page, { action: "toggle-environment-menu" });
  await clickSceneObject(page, { action: "set-environment:underwater" });
  const beforeUnderwaterFrame = await page.evaluate(
    () => window.__souvenirApp.environmentEffects.material.uniforms.uTime.value,
  );
  await expect.poll(() =>
    page.evaluate(
      (before) => window.__souvenirApp.environmentEffects.material.uniforms.uTime.value > before,
      beforeUnderwaterFrame,
    ),
  ).toBe(true);

  await page.evaluate(() => {
    const app = window.__souvenirApp;
    const renderer = app.renderer;
    const originalRender = renderer.render.bind(renderer);
    window.__environmentRenderTrace = { calls: [], originalRender };
    renderer.render = (scene, camera) => {
      window.__environmentRenderTrace.calls.push(
        scene === app.environmentEffectScene ? "environment" : scene === app.scene ? "main" : "other",
      );
      return originalRender(scene, camera);
    };
  });
  await expect.poll(() =>
    page.evaluate(() => window.__environmentRenderTrace.calls.length),
  ).toBeGreaterThanOrEqual(4);
  const renderTrace = await page.evaluate(() => {
    const app = window.__souvenirApp;
    const trace = window.__environmentRenderTrace;
    app.renderer.render = trace.originalRender;
    return trace.calls;
  });
  expect(renderTrace.some(
    (call, index) => call === "environment" && renderTrace[index + 1] === "main",
  )).toBe(true);
  const renderPasses = await page.evaluate(
    () => window.__souvenirApp.environmentEffects.renderPasses,
  );
  expect(renderPasses.background).toBeGreaterThan(0);
  expect(renderPasses.main).toBe(renderPasses.background);
  expect(renderPasses.depthClears).toBe(renderPasses.background);

  await clickSceneObject(page, { action: "toggle-environment-menu" });
  await clickSceneObject(page, { action: "set-environment:red" });
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("souvenir.layout.v1") ?? "{}");
    return saved.environmentMode;
  })).toBe("red");

  const toolbarBeforeDrag = await page.evaluate(() => ({
    position: window.__souvenirApp.toolbar.position.toArray(),
    quaternion: window.__souvenirApp.toolbar.quaternion.toArray(),
  }));
  await dragSceneObject(page, { kind: "toolbar-surface" }, { x: 0, y: 0.06, z: 0 });
  await expect.poll(() => page.evaluate((before) =>
    window.__souvenirApp.toolbar.position.distanceTo({
      x: before.position[0],
      y: before.position[1],
      z: before.position[2],
    }), toolbarBeforeDrag,
  )).toBeGreaterThan(0.05);
  const panelCount = await page.evaluate(() => window.__souvenirApp.store.getState().panels.length);
  await clickSceneObject(page, { action: "add-panel" });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels.length),
  ).toBe(panelCount + 1);
  await clickSceneObject(page, { action: "remove-panel" });
  await expect.poll(() =>
    page.evaluate(() => window.__souvenirApp.store.getState().panels.length),
  ).toBe(panelCount);

  await page.locator("#exit-preview").click();
  await page.reload();
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    mode: window.__souvenirApp.environmentMode,
    selected: window.__souvenirApp.toolbar.environmentButtons.get("red")?.userData.selected,
  }))).toEqual({ mode: "red", selected: true });
});
