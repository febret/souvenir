import { describe, expect, it, vi } from "vitest";

import { PanelCoordinator } from "../../app/src/scene/panel-coordinator.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("PanelCoordinator", () => {
  it("guards each panel from overlapping inline tag saves", async () => {
    const save = deferred();
    const saveMediaTags = vi.fn(() => save.promise);
    const panel = { id: "panel-1", media: { selectedId: "photo.jpg" } };
    const coordinator = Object.assign(Object.create(PanelCoordinator.prototype), {
      api: { saveMediaTags },
      panelState: { panels: [panel], focusedId: panel.id },
      store: { focus: vi.fn() },
      panelViews: new Map(),
      runtime: new Map(),
      browser: null,
      mediaTagLookup: new Map([["photo.jpg", []]]),
      pendingTagSaves: new Set(),
      onError: vi.fn(),
    });

    coordinator.handleAction(panel.id, "toggle-media-tag:horse");
    coordinator.handleAction(panel.id, "toggle-media-tag:blue");

    expect(coordinator.isTagSavePending(panel.id)).toBe(true);
    expect(saveMediaTags).toHaveBeenCalledTimes(1);
    expect(saveMediaTags).toHaveBeenCalledWith("photo.jpg", ["horse"]);

    save.resolve();
    await vi.waitFor(() => {
      expect(coordinator.mediaTagLookup.get("photo.jpg")).toEqual(["horse"]);
      expect(coordinator.isTagSavePending(panel.id)).toBe(false);
    });
  });
});
