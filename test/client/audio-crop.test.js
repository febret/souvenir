import { describe, expect, it } from "vitest";

import {
  audioBufferToWav,
  cropAudioBuffer,
  normalizeCrop,
  timeLabel,
} from "../../app/src/core/audio-crop.js";

function makeBuffer({ sampleRate = 8000, channels = 1, duration = 1, fill = 0 } = {}) {
  const length = Math.round(duration * sampleRate);
  const context = { createBuffer: (count, len, rate) => {
    const buffer = {
      numberOfChannels: count,
      sampleRate: rate,
      length: len,
      duration: len / rate,
      context,
      _data: [],
    };
    Object.defineProperty(buffer, "getChannelData", {
      value: (index) => buffer._data[index],
    });
    for (let channel = 0; channel < count; channel += 1) {
      const data = new Float32Array(len).fill(fill);
      buffer._data[channel] = data;
    }
    return buffer;
  } };
  return context.createBuffer(channels, length, sampleRate);
}

describe("normalizeCrop", () => {
  it("clamps, swaps, and falls back to the duration", () => {
    expect(normalizeCrop(-5, 99, 10)).toEqual({ start: 0, end: 10 });
    expect(normalizeCrop(8, 2, 10)).toEqual({ start: 2, end: 8 });
    expect(normalizeCrop(1, 2, "garbage")).toEqual({ start: 0, end: 0 });
  });
});

describe("cropAudioBuffer", () => {
  it("copies the requested range with an explicit context", () => {
    const source = makeBuffer({ sampleRate: 10, channels: 2, duration: 4 });
    for (let channel = 0; channel < 2; channel += 1) {
      source.getChannelData(channel).set(Array.from({ length: 40 }, (_, index) => index));
    }

    const clipped = cropAudioBuffer(source, 1.5, 3, source.context);

    expect(clipped.length).toBe(15);
    expect(clipped.getChannelData(0).slice(0, 3)).toEqual(new Float32Array([15, 16, 17]));
    expect(clipped.getChannelData(1).slice(0, 3)).toEqual(new Float32Array([15, 16, 17]));
  });
});

describe("audioBufferToWav", () => {
  it("writes a RIFF/WAVE container with 16-bit PCM", async () => {
    const source = makeBuffer({ sampleRate: 8000, channels: 1, duration: 0.001 });
    source.getChannelData(0)[0] = 1;

    const blob = audioBufferToWav(source);
    const view = new DataView(await blob.arrayBuffer());

    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + 2 * source.length);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getInt16(44, true)).toBe(0x7fff);
  });
});

describe("timeLabel", () => {
  it("formats time and falls back to zero", () => {
    expect(timeLabel(65.4)).toBe("1:05.4");
    expect(timeLabel("nope")).toBe("0:00.0");
  });
});
