import { describe, expect, it } from "vitest";

import { CommentaryAddDialog } from "../../app/src/ui/commentary-add-dialog.js";

function fakeAudio() {
  return {
    preload: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    pause: () => {},
    removeAttribute: () => {},
    load: () => {},
    hasAttribute: () => false,
  };
}

function createDialog({ prefs = {}, onPrefs = null } = {}) {
  let stored = { ...prefs };
  const document = {
    createElement: () => fakeAudio(),
  };
  const dialog = new CommentaryAddDialog({
    document,
    api: {},
    elements: {},
    getTtsPrefs: () => ({ ...stored }),
    setTtsPrefs: (next) => {
      stored = { ...next };
      onPrefs?.(next);
    },
  });
  return { dialog, getStored: () => ({ ...stored }) };
}

describe("commentary add dialog TTS prefs", () => {
  it("loads initial voice, pitch and rate from prefs", () => {
    const { dialog } = createDialog({
      prefs: { voice: "voice-b", pitch: 12, rate: -8 },
    });
    expect(dialog.voice).toBe("voice-b");
    expect(dialog.pitch).toBe(12);
    expect(dialog.rate).toBe(-8);
  });

  it("restores last prefs on reset instead of clearing to defaults", () => {
    const { dialog, getStored } = createDialog({
      prefs: { voice: "voice-b", pitch: 12, rate: -8 },
    });
    dialog.voices = [{ id: "voice-a" }, { id: "voice-b" }];

    // Simulate user navigating away and reopening: transient state cleared,
    // but TTS prefs must survive via reset().
    dialog.text = "hello";
    dialog.voice = "changed-transiently";
    dialog.pitch = 0;
    dialog.rate = 0;
    dialog.reset();

    expect(dialog.text).toBe("");
    expect(dialog.voice).toBe("voice-b");
    expect(dialog.pitch).toBe(12);
    expect(dialog.rate).toBe(-8);
    expect(getStored()).toEqual({ voice: "voice-b", pitch: 12, rate: -8 });

    const reopened = createDialog({ prefs: getStored() });
    expect(reopened.dialog.voice).toBe("voice-b");
    expect(reopened.dialog.pitch).toBe(12);
    expect(reopened.dialog.rate).toBe(-8);
  });

  it("persists tuning changes and normalizes invalid prefs", () => {
    const seen = [];
    const { dialog } = createDialog({
      prefs: { voice: "", pitch: 0, rate: 0 },
      onPrefs: (next) => seen.push(next),
    });
    dialog.voice = "voice-a";
    dialog.pitch = 20;
    dialog.rate = -20;
    dialog.persistTtsPrefs();
    expect(seen.at(-1)).toEqual({ voice: "voice-a", pitch: 20, rate: -20 });

    const invalid = createDialog({
      prefs: { voice: 123, pitch: Number.NaN, rate: 999 },
    });
    expect(invalid.dialog.voice).toBe("");
    expect(invalid.dialog.pitch).toBe(0);
    expect(invalid.dialog.rate).toBe(50);
  });
});
