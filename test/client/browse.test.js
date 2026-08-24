import { describe, expect, it } from "vitest";

import {
  assignmentsAfterTagToggle,
  clampBrowseTransform,
  matchesTagCountFilter,
  tagSelectionState,
  updateBrowseSelection,
  zoomBrowseTransform,
} from "../../app/src/core/browse.js";

describe("browse selection", () => {
  const ids = ["a", "b", "c", "d"];

  it("supports replacement, toggle, and anchored ranges", () => {
    let result = updateBrowseSelection(new Set(), ids, 1);
    expect([...result.selectedIds]).toEqual(["b"]);

    result = updateBrowseSelection(result.selectedIds, ids, 3, {
      toggle: true,
      anchorIndex: result.anchorIndex,
    });
    expect([...result.selectedIds]).toEqual(["b", "d"]);

    result = updateBrowseSelection(result.selectedIds, ids, 1, {
      range: true,
      anchorIndex: result.anchorIndex,
    });
    expect([...result.selectedIds]).toEqual(["b", "c", "d"]);
  });
});

describe("browse bulk tags", () => {
  const entries = [
    { path: "a.jpg", tag_ids: ["blue"] },
    { path: "b.jpg", tag_ids: ["horse", "blue"] },
  ];

  it("reports mixed assignment state", () => {
    expect(tagSelectionState(entries, "horse")).toEqual({
      checked: false,
      indeterminate: true,
    });
    expect(tagSelectionState(entries, "blue")).toEqual({
      checked: true,
      indeterminate: false,
    });
  });

  it("adds or removes one tag without replacing unrelated tags", () => {
    expect(assignmentsAfterTagToggle(entries, "horse", true)).toEqual([
      { path: "a.jpg", tag_ids: ["blue", "horse"] },
      { path: "b.jpg", tag_ids: ["horse", "blue"] },
    ]);
    expect(assignmentsAfterTagToggle(entries, "blue", false)).toEqual([
      { path: "a.jpg", tag_ids: [] },
      { path: "b.jpg", tag_ids: ["horse"] },
    ]);
  });
});

describe("browse tag-count filters", () => {
  const entry = (count) => ({
    tag_ids: Array.from({ length: count }, (_, index) => `tag-${index}`),
  });

  it("matches the requested count ranges", () => {
    expect(matchesTagCountFilter(entry(0), "0")).toBe(true);
    expect(matchesTagCountFilter(entry(1), "1-2")).toBe(true);
    expect(matchesTagCountFilter(entry(2), "1-2")).toBe(true);
    expect(matchesTagCountFilter(entry(3), "3-10")).toBe(true);
    expect(matchesTagCountFilter(entry(10), "3-10")).toBe(true);
    expect(matchesTagCountFilter(entry(10), "10+")).toBe(true);
    expect(matchesTagCountFilter(entry(11), "10+")).toBe(true);
    expect(matchesTagCountFilter(entry(3), "1-2")).toBe(false);
  });
});

describe("browse image transforms", () => {
  const metrics = {
    stageWidth: 800,
    stageHeight: 600,
    naturalWidth: 1600,
    naturalHeight: 800,
  };

  it("zooms around the requested point and clamps pan to image bounds", () => {
    const zoomed = zoomBrowseTransform({ zoom: 1, x: 0, y: 0 }, 2, { x: 100, y: 50 });
    expect(zoomed).toEqual({ zoom: 2, x: -100, y: -50 });
    expect(clampBrowseTransform({ zoom: 2, x: 999, y: -999 }, metrics)).toEqual({
      zoom: 2,
      x: 400,
      y: -100,
    });
  });

  it("keeps fit mode centered and enforces zoom limits", () => {
    expect(clampBrowseTransform({ zoom: 0, x: 50, y: 50 }, metrics)).toEqual({
      zoom: 1,
      x: 0,
      y: 0,
    });
    expect(clampBrowseTransform({ zoom: 99, x: 0, y: 0 }, metrics).zoom).toBe(8);
  });
});
