import { describe, expect, it } from "vitest";
import {
  mediaDisplayLayout,
  mediaScaleForPanel,
} from "../../app/src/core/media-display.js";

describe("media display layouts", () => {
  it("uniformly scales native-aspect media with the panel dimensions", () => {
    expect(mediaScaleForPanel({
      sourceWidth: 1600,
      sourceHeight: 900,
      panelWidth: 3.2,
      panelHeight: 1.8,
    })).toBe(2);
    expect(mediaDisplayLayout({
      sourceWidth: 1600,
      sourceHeight: 900,
      panelWidth: 3.2,
      panelHeight: 1.8,
    }).surface).toEqual({ width: 3.2, height: 1.8 });
  });

  it("fits mismatched panel dimensions without distorting native aspect ratio", () => {
    expect(mediaDisplayLayout({
      sourceWidth: 1600,
      sourceHeight: 900,
      panelWidth: 2,
      panelHeight: 2,
    }).surface).toEqual({ width: 2, height: 1.125 });
  });
});
