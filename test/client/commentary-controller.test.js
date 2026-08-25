import { describe, expect, it, vi } from "vitest";

import { CommentaryController } from "../../app/src/scene/commentary-controller.js";

function audioFixture() {
  const listeners = new Map();
  return {
    currentTime: 0,
    volume: 1,
    addEventListener: vi.fn((type, listener) => listeners.set(type, listener)),
    removeEventListener: vi.fn((type) => listeners.delete(type)),
    removeAttribute: vi.fn(),
    load: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
    listeners,
  };
}

describe("CommentaryController", () => {
  it("owns commentary playback, captions, state, and disposal", async () => {
    const audio = audioFixture();
    const captionView = {
      setText: vi.fn(),
      setStyle: vi.fn(),
      updatePose: vi.fn(),
      dispose: vi.fn(),
    };
    const states = [];
    const controller = new CommentaryController({
      api: {
        commentary: vi.fn(() => Promise.resolve({
          entries: [{ file_path: "voice/intro.mp3", caption: "Hello#Again", volume: 0.4 }],
        })),
        commentaryFileUrl: (path) => `/commentary/${path}`,
      },
      getPanels: () => [{ media: { selectedId: "photo.jpg" } }],
      getMediaTagLookup: () => new Map([["photo.jpg", []]]),
      getSettings: () => ({
        captionSize: 1.2,
        captionTransparency: 0.25,
        captionDistance: 1.8,
      }),
      onStateChange: (state) => states.push(state),
      onError: vi.fn(),
      createAudio: () => audio,
      captionView,
    });

    await controller.refresh();
    await controller.toggle();

    expect(audio.src).toBe("/commentary/voice/intro.mp3");
    expect(audio.volume).toBe(0.4);
    expect(controller.playing).toBe(true);
    expect(states.at(-1)).toEqual({ available: true, enabled: true, playing: true });

    audio.currentTime = 2;
    const camera = {};
    controller.update(camera);
    expect(captionView.setText).toHaveBeenLastCalledWith("Again");
    expect(captionView.setStyle).toHaveBeenCalledWith({ size: 1.2, transparency: 0.25 });
    expect(captionView.updatePose).toHaveBeenCalledWith(camera, 1.8);

    controller.dispose();
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.removeEventListener).toHaveBeenCalledTimes(2);
    expect(captionView.dispose).toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ available: true, enabled: false, playing: false });
  });
});
