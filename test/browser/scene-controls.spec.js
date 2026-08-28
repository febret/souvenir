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

test("creates scenes, excludes minimized panels, transitions shots, and stops on the last shot", async ({
  page,
}) => {
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await expect(page.locator("#scenes-section")).toBeVisible();
  await page.locator("#scene-create-name").fill("Family room");
  await page.locator("#scene-create-button").click();
  await expect(page.locator("#scene-select")).toHaveValue("scene-1");
  await page.locator("#scene-duration").fill("1");
  await page.locator("#scene-duration").dispatchEvent("change");
  await expect(page.locator("#scene-duration-value")).toHaveText("1 sec");
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();
  await expect(page.locator("#scene-select")).toHaveValue("scene-1");

  const panelIds = await page.evaluate(() => {
    const app = window.__souvenirApp;
    const first = app.store.getState().focusedId;
    const second = app.store.add({
      transform: {
        position: { x: 0.9, y: 1.35, z: -1.45 },
        rotation: { x: 0, y: 0.2, z: 0 },
      },
      dimensions: { width: 0.9, height: 0.6 },
    });
    app.store.minimize(second.id);
    return { first, second: second.id };
  });

  await page.locator("#scene-capture-delete").click();
  await expect.poll(() => page.evaluate(() => {
    const scene = window.__souvenirApp.getSceneState();
    return {
      shots: scene.shots.length,
      capturedPanels: scene.shots[0]?.panels.map((panel) => panel.id),
      action: document.querySelector("#scene-capture-delete")?.textContent,
    };
  })).toEqual({
    shots: 1,
    capturedPanels: [panelIds.first],
    action: "Delete shot",
  });

  await page.evaluate(({ second }) => {
    const app = window.__souvenirApp;
    app.store.restore(second);
    app.store.setTransform(second, {
      position: { x: 1.1, y: 1.5, z: -1.7 },
      rotation: { x: 0, y: 0.4, z: 0 },
    });
  }, panelIds);
  await expect(page.locator("#scene-capture-delete")).toHaveText("Capture shot");
  await page.locator("#scene-capture-delete").click();
  await expect.poll(() => page.evaluate(() => {
    const scene = window.__souvenirApp.getSceneState();
    return {
      shots: scene.shots.length,
      secondShotPanels: scene.shots[1]?.panels.length,
    };
  })).toEqual({ shots: 2, secondShotPanels: 2 });

  await page.locator("#scene-loop-mode").selectOption("stop");
  await page.locator("#scene-shot-select").selectOption("0");
  await expect.poll(() => page.evaluate(({ second }) => {
    const view = window.__souvenirApp.panelViews.get(second);
    return view?.surface.material.opacity ?? null;
  }, panelIds)).toBeLessThan(1);
  await expect.poll(() => page.evaluate(({ second }) => {
    const view = window.__souvenirApp.panelViews.get(second);
    const interactive = [];
    view?.traverse((object) => {
      if (Object.prototype.hasOwnProperty.call(object.userData ?? {}, "interactive")) {
        interactive.push(object.userData.interactive);
      }
    });
    return interactive.length > 0 && interactive.every((value) => value === false);
  }, panelIds)).toBe(true);
  await expect.poll(() => page.evaluate(
    ({ second }) => window.__souvenirApp.store.getState().panels.some((panel) => panel.id === second),
    panelIds,
  ), { timeout: 2500 }).toBe(false);

  await page.locator("#scene-playback-toggle").click();
  await expect(page.locator("#scene-playback-toggle")).toHaveText("Stop");
  await expect.poll(() => page.evaluate(() => {
    const scene = window.__souvenirApp.getSceneState();
    return {
      active: scene.playback_active,
      selected: scene.selected_shot_index,
    };
  }), { timeout: 3500 }).toEqual({ active: false, selected: 1 });
  await expect(page.locator("#scene-playback-toggle")).toHaveText("Play");
  await expect.poll(() => page.evaluate(
    ({ second }) => window.__souvenirApp.store.getState().panels.some((panel) => panel.id === second),
    panelIds,
  )).toBe(true);

  await page.locator("#scene-loop-mode").selectOption("loop");
  await page.locator("#scene-shot-select").selectOption("0");
  await page.locator("#scene-playback-toggle").click();
  await expect.poll(() => page.evaluate(() => ({
    active: window.__souvenirApp.getSceneState().playback_active,
    selected: window.__souvenirApp.getSceneState().selected_shot_index,
  })), { timeout: 2500 }).toEqual({ active: true, selected: 1 });
  await expect.poll(() => page.evaluate(() => ({
    active: window.__souvenirApp.getSceneState().playback_active,
    selected: window.__souvenirApp.getSceneState().selected_shot_index,
  })), { timeout: 2500 }).toEqual({ active: true, selected: 0 });
  await page.locator("#scene-playback-toggle").click();
  await expect(page.locator("#scene-capture-delete")).toHaveText("Delete shot");
  await page.locator("#scene-capture-delete").click();
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.getSceneState().shots.length)).toBe(1);

  await page.locator("#scene-select").selectOption("");
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.getSceneState().id)).toBeNull();
  await page.locator("#scene-select").selectOption("scene-1");
  await expect.poll(() => page.evaluate(() => {
    const scene = window.__souvenirApp.getSceneState();
    return {
      id: scene.id,
      shots: scene.shots.length,
      selected: scene.selected_shot_index,
    };
  })).toEqual({ id: "scene-1", shots: 1, selected: 0 });
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
  for (const [name, dimensions, minimum, expectsCanvas] of [
    ["backdrop", browserDetails.backdrop, { width: 2400, height: 1600 }, true],
    ["entry", browserDetails.entry, { width: 1280, height: 320 }, true],
    ["control", browserDetails.control, { width: 1024, height: 256 }, true],
  ]) {
    expect(dimensions, `Expected a texture for ${name}`).toMatchObject({
      isCanvas: expectsCanvas,
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

test("prompts and enables ADM with generated depth data", async ({ page }) => {
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#adm-default-depth-intensity").fill("0.8");
  await page.locator("#adm-max-resolution").fill("128");
  await expect(page.locator("#adm-default-depth-intensity-value")).toHaveText("0.80×");
  await expect(page.locator("#adm-max-resolution-value")).toHaveText("128 px");
  await expect
    .poll(() => page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem("souvenir.settings") ?? "{}");
      return {
        intensity: settings.admDefaultDepthIntensity,
        resolution: settings.admMaxResolution,
      };
    }))
    .toEqual({ intensity: 0.8, resolution: 128 });
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();

  const panelId = await page.evaluate(() => window.__souvenirApp.store.getState().focusedId);
  await selectBeachImage(page, panelId);
  await expect
    .poll(() => page.evaluate((id) => {
      const app = window.__souvenirApp;
      return {
        mediaType: app.panelViews.get(id)?.mediaType ?? null,
        intensity: app.store.getState().panels.find((panel) => panel.id === id)
          ?.depthIntensity ?? null,
      };
    }, panelId))
    .toEqual({ mediaType: "image", intensity: 0.8 });
  await clickSceneObject(page, { action: "toggle-options", panelId });
  await expect
    .poll(() => page.evaluate((id) =>
      Boolean(window.__souvenirApp.panelViews.get(id)?.optionsPanel.visible),
    panelId))
    .toBe(true);
  await clickSceneObject(page, { action: "toggle-3d-mode", panelId });
  await expect
    .poll(() => page.evaluate((id) => {
      const app = window.__souvenirApp;
      const view = app.panelViews.get(id);
      return {
        visible: Boolean(view?.admPromptVisible),
        enabled: app.store.getState().panels.find((panel) => panel.id === id)?.admEnabled,
        error: document.querySelector("#app-error")?.textContent ?? "",
      };
    }, panelId))
    .toEqual({ visible: true, enabled: false, error: "" });
  await clickSceneObject(page, { action: "adm-generate-confirm", panelId });
  await expect
    .poll(() => page.evaluate((id) => {
      const app = window.__souvenirApp;
      const panel = app.store.getState().panels.find((item) => item.id === id);
      const view = app.panelViews.get(id);
      return {
        enabled: panel?.admEnabled ?? false,
        hasDepth: Boolean(view?.depthMapCanvas),
        status: app.autoAdmStates.get("albums/beach.jpg")?.status ?? "missing",
        cached: app.depthCache.has("albums/beach.jpg"),
        meshDisplaced: view?.surface.geometry !== view?.surfaceFlatGeometry,
        meshResolution: Math.max(
          view?.surface.geometry.parameters.widthSegments ?? 0,
          view?.surface.geometry.parameters.heightSegments ?? 0,
        ),
        intensity: panel?.depthIntensity ?? null,
        minimumMeshDepth: Math.min(
          ...Array.from(view?.surface.geometry.attributes.position.array ?? [])
            .filter((_, index) => index % 3 === 2),
        ),
        depthSliderInteractive: Boolean(view?.depthSlider.track.userData.interactive),
        error: document.querySelector("#app-error")?.textContent ?? "",
      };
    }, panelId))
    .toEqual({
      enabled: true,
      hasDepth: true,
      status: "completed",
      cached: true,
      meshDisplaced: true,
      meshResolution: 128,
      intensity: 0.8,
      minimumMeshDepth: expect.any(Number),
      depthSliderInteractive: true,
      error: "",
    });
  const minimumMeshDepth = await page.evaluate((id) => {
    const positions = window.__souvenirApp.panelViews.get(id)
      ?.surface.geometry.attributes.position.array ?? [];
    return Math.min(...Array.from(positions).filter((_, index) => index % 3 === 2));
  }, panelId);
  expect(minimumMeshDepth).toBeGreaterThan(0);
  const uiDepths = await page.evaluate((id) => {
    const app = window.__souvenirApp;
    const view = app.panelViews.get(id);
    // In desktop overlay mode, controls/optionsPanel are in the overlayScene and
    // always drawn in front via clearDepth(); depth-value comparison doesn't apply.
    if (view?.overlayScene) {
      return {
        overlayMode: true,
        controlsInOverlay: app.desktopOverlayScene?.children.includes(view.controls) ?? false,
        optionsInOverlay: app.desktopOverlayScene?.children.includes(view.optionsPanel) ?? false,
        maximumSurfaceDepth: null,
        controlDepth: null,
        optionsDepth: null,
      };
    }
    const positions = Array.from(view?.surface.geometry.attributes.position.array ?? []);
    const surfaceDepths = positions.filter((_, index) => index % 3 === 2);
    const maximumSurfaceDepth = Math.max(...surfaceDepths);
    const controlDepth = Math.max(
      ...view.controls.children.map((control) => view.controls.position.z + (control.position?.z ?? 0)),
    );
    const optionsBackdrop = view.optionsPanel.children[0];
    const optionsDepth = view.optionsPanel.position.z + (optionsBackdrop?.position?.z ?? 0);
    return { overlayMode: false, maximumSurfaceDepth, controlDepth, optionsDepth };
  }, panelId);
  if (uiDepths.overlayMode) {
    expect(uiDepths.controlsInOverlay).toBe(true);
    expect(uiDepths.optionsInOverlay).toBe(true);
  } else {
    expect(uiDepths.controlDepth).toBeGreaterThan(uiDepths.maximumSurfaceDepth);
    expect(uiDepths.optionsDepth).toBeGreaterThan(uiDepths.maximumSurfaceDepth);
  }

  const secondPanelId = await page.evaluate(() => {
    const app = window.__souvenirApp;
    return app.store.add({
      transform: { position: { x: 0.5, y: 1.35, z: -1.45 } },
    }).id;
  });
  await selectBeachImage(page, secondPanelId);
  await expect
    .poll(() => page.evaluate((id) => {
      const app = window.__souvenirApp;
      const panel = app.store.getState().panels.find((item) => item.id === id);
      const view = app.panelViews.get(id);
      return {
        enabled: panel?.admEnabled ?? false,
        intensity: panel?.depthIntensity ?? null,
        hasDepth: Boolean(view?.depthMapCanvas),
        meshDisplaced: view?.surface.geometry !== view?.surfaceFlatGeometry,
      };
    }, secondPanelId))
    .toEqual({
      enabled: true,
      intensity: 0.8,
      hasDepth: true,
      meshDisplaced: true,
    });
});

test("keeps panel UI and options in front of displaced 3D depth", async ({ page }) => {
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();

  const panelId = await page.evaluate(() => window.__souvenirApp.store.getState().focusedId);
  await selectBeachImage(page, panelId);
  await clickSceneObject(page, { action: "toggle-options", panelId });
  await clickSceneObject(page, { action: "toggle-3d-mode", panelId });
  const admState = await page.evaluate((id) => {
    const app = window.__souvenirApp;
    const panel = app.store.getState().panels.find((entry) => entry.id === id);
    const view = app.panelViews.get(id);
    return {
      enabled: Boolean(panel?.admEnabled),
      promptVisible: Boolean(view?.admPromptVisible),
    };
  }, panelId);
  if (admState.promptVisible && !admState.enabled) {
    await clickSceneObject(page, { action: "adm-generate-confirm", panelId });
  }
  await expect.poll(() => page.evaluate((id) => {
    const app = window.__souvenirApp;
    const panel = app.store.getState().panels.find((entry) => entry.id === id);
    const view = app.panelViews.get(id);
    return {
      enabled: Boolean(panel?.admEnabled),
      meshDisplaced: view?.surface.geometry !== view?.surfaceFlatGeometry,
    };
  }, panelId)).toEqual({ enabled: true, meshDisplaced: true });

  const uiDepths = await page.evaluate((id) => {
    const app = window.__souvenirApp;
    const view = app.panelViews.get(id);
    if (view?.overlayScene) {
      return {
        overlayMode: true,
        controlsInOverlay: app.desktopOverlayScene?.children.includes(view.controls) ?? false,
        optionsInOverlay: app.desktopOverlayScene?.children.includes(view.optionsPanel) ?? false,
        maximumSurfaceDepth: null,
        controlDepth: null,
        optionsDepth: null,
      };
    }
    const depthValues = Array.from(view?.surface.geometry.attributes.position.array ?? [])
      .filter((_, index) => index % 3 === 2);
    const maximumSurfaceDepth = Math.max(...depthValues);
    const controlDepth = Math.max(
      ...view.controls.children.map((control) => view.controls.position.z + (control.position?.z ?? 0)),
    );
    const optionsBackdrop = view.optionsPanel.children[0];
    const optionsDepth = view.optionsPanel.position.z + (optionsBackdrop?.position?.z ?? 0);
    return { overlayMode: false, maximumSurfaceDepth, controlDepth, optionsDepth };
  }, panelId);

  if (uiDepths.overlayMode) {
    expect(uiDepths.controlsInOverlay).toBe(true);
    expect(uiDepths.optionsInOverlay).toBe(true);
  } else {
    expect(uiDepths.controlDepth).toBeGreaterThan(uiDepths.maximumSurfaceDepth);
    expect(uiDepths.optionsDepth).toBeGreaterThan(uiDepths.maximumSurfaceDepth);
  }
});

test("collapses and expands the panel tag list without hiding the options panel", async ({ page }) => {
  await page.goto("/?debug=1");
  await page.locator('.directory-row input[value="albums"]').check();
  await page.locator("#preview-button").click();
  await expect(page.locator("#scene-shell")).toBeVisible();

  const panelId = await page.evaluate(() => window.__souvenirApp.store.getState().focusedId);
  await selectBeachImage(page, panelId);
  await page.evaluate((id) => {
    const view = window.__souvenirApp.panelViews.get(id);
    view.setTagDefinitions([
      { id: "tag-1", name: "Sunrise" },
      { id: "tag-2", name: "Forest" },
      { id: "tag-3", name: "Ocean" },
      { id: "tag-4", name: "Clouds" },
    ]);
  }, panelId);
  await clickSceneObject(page, { action: "toggle-options", panelId });
  await expect.poll(() => page.evaluate((id) => {
    const view = window.__souvenirApp.panelViews.get(id);
    const tagButtons = view?.optionsPanel.content.children.filter((child) => child.userData?.action?.startsWith("toggle-media-tag:"));
    return {
      visible: view?.optionsPanel.visible,
      tagCount: tagButtons?.length ?? 0,
      expanded: view?.tagListExpanded,
      offsetX: tagButtons?.[0]?.position?.x ?? null,
    };
  }, panelId)).toMatchObject({ visible: true, expanded: true, offsetX: expect.any(Number) });

  await clickSceneObject(page, { action: "toggle-tag-list", panelId });
  await expect.poll(() => page.evaluate((id) => {
    const view = window.__souvenirApp.panelViews.get(id);
    const tagButtons = view?.optionsPanel.content.children.filter((child) => child.userData?.action?.startsWith("toggle-media-tag:"));
    return {
      tagCount: tagButtons?.length ?? 0,
      expanded: view?.tagListExpanded,
      offsetX: tagButtons?.[0]?.position?.x ?? null,
    };
  }, panelId)).toEqual({ tagCount: 0, expanded: false, offsetX: null });

  await clickSceneObject(page, { action: "toggle-tag-list", panelId });
  await expect.poll(() => page.evaluate((id) => {
    const view = window.__souvenirApp.panelViews.get(id);
    const tagButtons = view?.optionsPanel.content.children.filter((child) => child.userData?.action?.startsWith("toggle-media-tag:"));
    return {
      tagCount: tagButtons?.length ?? 0,
      expanded: view?.tagListExpanded,
      offsetX: tagButtons?.[0]?.position?.x ?? null,
    };
  }, panelId)).toMatchObject({ tagCount: expect.any(Number), expanded: true, offsetX: expect.any(Number) });
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
  await selectBeachImage(page, panelId);
  await expect.poll(() => page.evaluate((id) =>
    window.__souvenirApp.panelViews.get(id)?.mediaLoaded, panelId)).toBe(true);
  const result = await page.evaluate((id) => {
    const app = window.__souvenirApp;
    const view = app.panelViews.get(id);
    const initialSurfaceScale = {
      x: view.surface.scale.x,
      y: view.surface.scale.y,
    };
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
      initialSurfaceScale,
      scaledSurfaceScale: {
        x: view.surface.scale.x,
        y: view.surface.scale.y,
      },
    };
  }, panelId);

  expect(result.panel.transform).toEqual({
    position: { x: 0.37, y: 1.62, z: -1.8 },
    rotation: { x: 0.1, y: -0.2, z: 0.05 },
  });
  expect(result.panel.dimensions).toEqual({ width: 1.8, height: 1.2 });
  expect(result.scaledSurfaceScale.x / result.initialSurfaceScale.x).toBeCloseTo(1.5);
  expect(result.scaledSurfaceScale.y / result.initialSurfaceScale.y).toBeCloseTo(1.5);
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
    { mode: "dark", color: 0x000000, opacity: 0.6, underwater: 0, visible: true },
    { mode: "night", color: 0x07162f, opacity: 0.9, underwater: 0, visible: true },
    { mode: "underwater", color: 0x087eaa, opacity: 0.8, underwater: 1, visible: true },
    { mode: "red", color: 0x75070c, opacity: 0.8, underwater: 0, visible: true },
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
  expect(renderPasses.main).toBeGreaterThan(renderPasses.background);
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
