import { describe, expect, it } from "vitest";
import {
  createSlideshowState,
  normalizeRepeatMode,
  shouldReplayAdvance,
  slideshowTransition,
} from "../../app/src/core/slideshow.js";

const a = { id: "a", name: "a.jpg" };
const b = { id: "b", name: "b.jpg" };
const c = { id: "c", name: "c.jpg" };
const video = { id: "v", name: "v.mp4" };

describe("slideshow shuffle/repeat", () => {
  it("normalizes unknown repeat modes to all", () => {
    expect(normalizeRepeatMode("everything")).toBe("all");
    expect(normalizeRepeatMode("one")).toBe("one");
    expect(createSlideshowState({ repeat: "bogus" }).repeat).toBe("all");
    expect(createSlideshowState({}).shuffle).toBe(false);
  });

  it("repeats one item without advancing the playlist", () => {
    const state = createSlideshowState({ active: true, currentMediaId: "a", repeat: "one", lastAdvanceAt: 0 });
    const transition = slideshowTransition(
      state,
      { type: "tick", now: 6000 },
      { playlist: [a, b], currentMedia: a },
    );
    expect(transition.action).toEqual({ type: "advance", media: a });
    expect(transition.state.active).toBe(true);
  });

  it("stops ordered playback at the end when repeat is off", () => {
    const state = createSlideshowState({ active: true, currentMediaId: "b", repeat: "off", lastAdvanceAt: 0 });
    const transition = slideshowTransition(
      state,
      { type: "tick", now: 6000 },
      { playlist: [a, b], currentMedia: b },
    );
    expect(transition.action).toBeNull();
    expect(transition.state.active).toBe(false);
  });

  it("wraps ordered playback when repeat is all", () => {
    const state = createSlideshowState({ active: true, currentMediaId: "b", repeat: "all", lastAdvanceAt: 0 });
    const transition = slideshowTransition(
      state,
      { type: "tick", now: 6000 },
      { playlist: [a, b], currentMedia: b },
    );
    expect(transition.action).toEqual({ type: "advance", media: a });
  });

  it("picks a different shuffle item with an injectable random", () => {
    const state = createSlideshowState({ active: true, currentMediaId: "a", shuffle: true, lastAdvanceAt: 0 });
    const transition = slideshowTransition(
      state,
      { type: "tick", now: 6000, random: () => 0.99 },
      { playlist: [a, b, c], currentMedia: a },
    );
    expect(transition.action?.media).toEqual(c);
    expect(transition.state.currentMediaId).toBe("c");
  });

  it("does not advance videos on timer ticks even when shuffled", () => {
    const state = createSlideshowState({ active: true, currentMediaId: "v", shuffle: true, lastAdvanceAt: 0 });
    const idle = slideshowTransition(
      state,
      { type: "tick", now: 999999 },
      { playlist: [a, video], currentMedia: video },
    );
    expect(idle.action).toBeNull();
  });

  it("flags same-item advances so the coordinator force-reloads instead of no-op setMedia", () => {
    expect(shouldReplayAdvance({ type: "advance", media: a }, "a")).toBe(true);
    expect(shouldReplayAdvance({ type: "advance", media: a }, null)).toBe(false);
  });
});
