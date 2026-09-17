import { describe, expect, it } from "vitest";

import { createPanelStore } from "../../app/src/core/panel-store.js";

describe("panel slideshow shuffle/repeat persistence", () => {
  it("defaults shuffle to false and repeat to all", () => {
    const store = createPanelStore({ panels: [{ id: "p1" }] });
    const panel = store.getState().panels[0];
    expect(panel.slideshowShuffle).toBe(false);
    expect(panel.slideshowRepeat).toBe("all");
  });

  it("round-trips shuffle/repeat through restore", () => {
    const store = createPanelStore({
      panels: [{ id: "p1", slideshowShuffle: true, slideshowRepeat: "one" }],
    });
    const restored = createPanelStore({ panels: store.getState().panels });
    const panel = restored.getState().panels[0];
    expect(panel.slideshowShuffle).toBe(true);
    expect(panel.slideshowRepeat).toBe("one");
  });

  it("updates shuffle/repeat with idempotent setters", () => {
    const store = createPanelStore({ panels: [{ id: "p1" }] });
    store.setSlideshowShuffle("p1", true);
    store.setSlideshowRepeat("p1", "off");
    expect(store.getState().panels[0]).toMatchObject({ slideshowShuffle: true, slideshowRepeat: "off" });
    expect(store.setSlideshowRepeat("p1", "bogus").slideshowRepeat).toBe("all");
  });
});
