import { describe, expect, it } from "vitest";
import { PanelStore } from "../../app/src/core/store.js";

function sequentialIds() {
  let id = 0;
  return () => `p${++id}`;
}

describe("single panel selection", () => {
  it("clears the selection with unfocus while keeping every panel", () => {
    const store = new PanelStore({ idFactory: sequentialIds() });
    const seen = [];
    store.subscribe((state, change) => seen.push({ focusedId: state.focusedId, change }));
    store.add();
    store.add();
    expect(store.getState().focusedId).toBe("p2");

    expect(store.unfocus()).toBe(true);
    expect(store.getState().focusedId).toBeNull();
    expect(store.getState().panels).toHaveLength(2);

    // Deselecting with nothing selected is a no-op without notifications.
    const notifications = seen.length;
    expect(store.unfocus()).toBe(true);
    expect(seen).toHaveLength(notifications);
  });

  it("emits a focus change when deselecting so views can close their chrome", () => {
    const store = new PanelStore({ idFactory: sequentialIds() });
    store.add();
    let lastChange = null;
    store.subscribe((state, change) => {
      lastChange = { focusedId: state.focusedId, ...change };
    });
    store.unfocus();
    expect(lastChange).toMatchObject({
      type: "focus",
      focusChanged: true,
      focusedId: null,
      panelIds: ["p1"],
    });
  });
});
