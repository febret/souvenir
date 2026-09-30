import { describe, expect, it } from "vitest";

import { VIDEO_SEEK_STEP_SECONDS, videoSeekTarget } from "../../app/src/core/video-transport.js";

describe("video transport seek math", () => {
  it("skips a fixed 15 seconds in both directions", () => {
    expect(VIDEO_SEEK_STEP_SECONDS).toBe(15);
    expect(videoSeekTarget(10, VIDEO_SEEK_STEP_SECONDS, 120)).toBe(25);
    expect(videoSeekTarget(10, -VIDEO_SEEK_STEP_SECONDS, 120)).toBe(0);
    expect(videoSeekTarget(40, -VIDEO_SEEK_STEP_SECONDS, 120)).toBe(25);
  });

  it("clamps repeated skips to the media bounds", () => {
    expect(videoSeekTarget(0, -VIDEO_SEEK_STEP_SECONDS, 120)).toBe(0);
    expect(videoSeekTarget(5, -60, 120)).toBe(0);
    expect(videoSeekTarget(115, VIDEO_SEEK_STEP_SECONDS, 120)).toBe(120);
    expect(videoSeekTarget(115, 600, 120)).toBe(120);
  });

  it("skips without an upper bound while the duration is unknown", () => {
    expect(videoSeekTarget(10, VIDEO_SEEK_STEP_SECONDS, Number.NaN)).toBe(25);
    expect(videoSeekTarget(10, VIDEO_SEEK_STEP_SECONDS, Number.POSITIVE_INFINITY)).toBe(25);
    expect(videoSeekTarget(10, VIDEO_SEEK_STEP_SECONDS, 0)).toBe(25);
    expect(videoSeekTarget(10, VIDEO_SEEK_STEP_SECONDS, -5)).toBe(25);
  });

  it("treats an unusable current time as the start of the media", () => {
    expect(videoSeekTarget(Number.NaN, VIDEO_SEEK_STEP_SECONDS, 120)).toBe(15);
    expect(videoSeekTarget(-30, VIDEO_SEEK_STEP_SECONDS, 120)).toBe(15);
    expect(videoSeekTarget(-30, -VIDEO_SEEK_STEP_SECONDS, 120)).toBe(0);
  });

  it("rejects a delta that is not a usable number", () => {
    expect(videoSeekTarget(10, Number.NaN, 120)).toBe(null);
    expect(videoSeekTarget(10, Number.POSITIVE_INFINITY, 120)).toBe(null);
    expect(videoSeekTarget(10, "later", 120)).toBe(null);
  });
});
