import { describe, expect, it } from "vitest";
import { createSlideshowState, playbackPolicy, slideshowDelay, slideshowTransition } from "../../app/src/core/slideshow.js";

const image = { id: "image", name: "one.jpg" };
const video = { id: "video", name: "two.mp4" };

describe("slideshow state machine", () => {
  it("only advances images once their configured timer elapses", () => {
    const state = createSlideshowState({ active: true, intervalMs: 2000, currentMediaId: "image", lastAdvanceAt: 100 });
    expect(slideshowTransition(state, { type: "tick", now: 2099 }, { playlist: [image, video], currentMedia: image }).action).toBeNull();
    const transition = slideshowTransition(state, { type: "tick", now: 2100 }, { playlist: [image, video], currentMedia: image });
    expect(transition.action).toEqual({ type: "advance", media: video });
    expect(transition.state.currentMediaId).toBe("video");
  });

  it("never advances a video on a timer but advances it after ended", () => {
    const state = createSlideshowState({ active: true, currentMediaId: "video", lastAdvanceAt: 0 });
    expect(slideshowTransition(state, { type: "tick", now: 999999 }, { playlist: [image, video], currentMedia: video }).action).toBeNull();
    expect(slideshowTransition(state, { type: "media-ended", now: 20 }, { playlist: [image, video], currentMedia: video }).action.media).toBe(image);
    expect(slideshowDelay(state, video)).toBeNull();
  });

  it("keeps regular video autoplay available outside a slideshow", () => {
    expect(playbackPolicy(video, { autoplayVideos: true })).toMatchObject({ autoplay: true, loop: false });
    expect(playbackPolicy(video, { autoplayVideos: false })).toMatchObject({ autoplay: false });
    expect(playbackPolicy(video, { slideshowActive: true })).toMatchObject({ autoplay: true });
  });
});
