import { describe, expect, it } from "vitest";

import {
  CAPTION_MESSAGE_DURATION_MS,
  captionAtTime,
  parseCaptionTimeline,
} from "../../app/src/core/commentary-captions.js";

describe("commentary captions", () => {
  it("turns hash runs into one-second pauses between one-second messages", () => {
    expect(CAPTION_MESSAGE_DURATION_MS).toBe(1000);
    expect(parseCaptionTimeline("First##Second#Third")).toEqual([
      { text: "First", startMs: 0, endMs: 1000 },
      { text: "Second", startMs: 3000, endMs: 4000 },
      { text: "Third", startMs: 5000, endMs: 6000 },
    ]);
    expect(parseCaptionTimeline("## Delayed ")).toEqual([
      { text: "Delayed", startMs: 2000, endMs: 3000 },
    ]);
  });

  it("returns captions only inside their display window", () => {
    const timeline = parseCaptionTimeline("First#Second");
    expect(captionAtTime(timeline, 0)).toBe("First");
    expect(captionAtTime(timeline, 0.999)).toBe("First");
    expect(captionAtTime(timeline, 1)).toBe("");
    expect(captionAtTime(timeline, 2)).toBe("Second");
    expect(captionAtTime(timeline, 3)).toBe("");
    expect(captionAtTime([], 1)).toBe("");
  });
});
